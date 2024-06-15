/** @jsxImportSource frog/jsx */

import { Button, Frog, TextInput } from 'frog';
import { Box, Divider, Heading, Text, VStack, Rows, Row, Spacer, vars } from '@/app/utils/frog/ui';
import { devtools } from 'frog/dev';
import { neynar, type NeynarVariables } from 'frog/middlewares';
import { handle } from 'frog/next';
import { serveStatic } from 'frog/serve-static';
import neynarClient from '@/app/utils/neynar/client';
import { Cast, Channel, ChannelType, ReactionType, ValidateFrameActionResponse } from '@neynar/nodejs-sdk/build/neynar-api/v2';
import { Address } from 'viem';
import { getNetworkNumber, getUnlockProxyAddress } from '@/app/utils/unlock/membership';
import { getChannelRules, insertChannelRule } from '@/app/utils/supabase/server';
import { getAlchemyRpc } from '@/app/utils/alchemy/constants';
import { doAddressesHaveValidMembershipInRules, getLockName, getLockTotalKeys, getMembersOnlyReferralFee, getTokenOfOwnerByIndex } from '@/app/utils/viem/constants';
import { contracts } from '@unlock-protocol/contracts';

const app = new Frog({
  assetsPath: '/',
  basePath: '/api',
  ui: { vars },
  origin: process.env.APP_URL,
  imageOptions: {
    format: "png",
  },
  verify: process.env.NODE_ENV === 'production' // leave it as is, if not issue with frog local debug tool
});

const neynarMiddleware = neynar({
  apiKey: process.env.NEYNAR_API_KEY!,
  features: ["interactor", "cast"],
});

// Uncomment to use Edge Runtime
// export const runtime = 'edge'

enum ApiRoute {
  HOOK_SETUP = "HOOK-SETUP",
  HOOK_VALIDATE = "HOOK-VALIDATE",
  FRAME_SETUP = "FRAME-SETUP/:CHANNELID",
}

enum HookSetupResult {
  CAST_SUCCESS,
  CAST_ERROR,
  INVALID_AUTHOR,
  UNEXPECTED_ERROR,
  ROUTE_ERROR,
}

enum HookValidateResult {
  CAST_REACTION_SUCCESS,
  CAST_REACTION_ERROR,
  CAST_FRAME_SUCCESS,
  CAST_FRAME_ERROR,
  SETUP_TEXT,
  ROUTE_ERROR,
}

enum FrameSetupResult {
  FRAME_ACTION_VALID,
  FRAME_ACTION_INVALID,
  CAST_FRAME_SUCCESS,
  CAST_FRAME_ERROR,
  SETUP_TEXT,
  ROUTE_ERROR,
}

const statusMessage = {
  [ApiRoute.HOOK_SETUP]: {
    [HookSetupResult.CAST_SUCCESS]: `${ApiRoute.HOOK_SETUP} => CAST SENT SUCCESSFULLY`,
    [HookSetupResult.CAST_ERROR]: `${ApiRoute.HOOK_SETUP} => FAILED TO PUBLISH CAST`,
    [HookSetupResult.INVALID_AUTHOR]: `${ApiRoute.HOOK_SETUP} => CAST AUTHOR IS NOT CHANNEL OWNER`,
    [HookSetupResult.UNEXPECTED_ERROR]: `${ApiRoute.HOOK_SETUP} => POINT SHOULD NOT BE REACHED, CHECK NEYNAR HOOK`,
    [HookSetupResult.ROUTE_ERROR]: `${ApiRoute.HOOK_SETUP} => ROUTE ERROR`,
  },
  [ApiRoute.HOOK_VALIDATE]: {
    [HookValidateResult.CAST_REACTION_SUCCESS]: `${ApiRoute.HOOK_VALIDATE} => CAST REACTION SENT SUCCESSFULLY`,
    [HookValidateResult.CAST_REACTION_ERROR]: `${ApiRoute.HOOK_VALIDATE} => FAILED TO SEND CAST REACTION`,
    [HookValidateResult.CAST_FRAME_SUCCESS]: `${ApiRoute.HOOK_VALIDATE} => CAST AUTHOR IS NOT CHANNEL OWNER`,
    [HookValidateResult.CAST_FRAME_ERROR]: `${ApiRoute.HOOK_VALIDATE} => POINT SHOULD NOT BE REACHED, CHECK NEYNAR HOOK`,
    [HookValidateResult.SETUP_TEXT]: `${ApiRoute.HOOK_VALIDATE} => TEXT IS TO SETUP THE CHANNEL, NOT TO VALIDATE MEMBERSHIP`,
    [HookValidateResult.ROUTE_ERROR]: `${ApiRoute.HOOK_VALIDATE} => ROUTE ERROR`,
  },
  [ApiRoute.FRAME_SETUP]: {
    [FrameSetupResult.FRAME_ACTION_VALID]: `${ApiRoute.FRAME_SETUP} => FRAME ACTION IS VALID`,
    [FrameSetupResult.FRAME_ACTION_INVALID]: `${ApiRoute.FRAME_SETUP} => FRAME ACTION IS INVALID`,
  },
};

app.hono.post("/hook-setup", async (c) => {
  try {
    console.log("call start: hook-setup");

    const body = await c.req.json();
    let cast: Cast = body.data;

    // 1. Validate the cast author is the owner of the channel
    // 1.1 Get the channel owner
    let channel = await getChannel(cast.root_parent_url!);
    let channelId = channel?.id;
    let channelLead = channel?.lead?.fid;

    // 1.2 Get the cast author
    let castAuthor = cast.author.fid;

    // 1.3 Compare the channel owner and the cast author and validate the cast text is "@membersonly setup"
    // Probably second validation will be removed and just validated on the hook
    let castText = cast.text;

    if (channelLead == castAuthor) {
      if (castText == process.env.BOT_SETUP_TEXT) {
        const castResponse = await neynarClient.publishCast(
          process.env.SIGNER_UUID!,
          "",
          {
            replyTo: cast.hash,
            embeds: [
              {
                url: `${process.env.APP_URL}/api/frame-setup/${channelId}`,
              }
            ]
          }
        );
        if (castResponse.hash) {
          return c.json({ message: statusMessage[ApiRoute.HOOK_SETUP][HookSetupResult.CAST_SUCCESS] });
        } else {
          return c.json({ message: statusMessage[ApiRoute.HOOK_SETUP][HookSetupResult.CAST_ERROR] });
        }
      } else {
        return c.json({ message: statusMessage[ApiRoute.HOOK_SETUP][HookSetupResult.UNEXPECTED_ERROR] });
      }
    } else {
      return c.json({ message: statusMessage[ApiRoute.HOOK_SETUP][HookSetupResult.INVALID_AUTHOR] });
    }
  } catch (e) {
    return c.json({ message: statusMessage[ApiRoute.HOOK_SETUP][HookSetupResult.ROUTE_ERROR] });
  }
});

app.hono.post("/hook-validate", async (c) => {
  try {
    console.log("call start: hook-validate");

    const body = await c.req.json();
    let cast: Cast = body.data;

    if (isSetupCast(cast.text)) {
      return c.json({ message: statusMessage[ApiRoute.HOOK_VALIDATE][HookValidateResult.SETUP_TEXT] });
    } else {
      let username = body.data.author.username;
      let castHash = body.data.hash;
      let channel = await getChannel(cast.root_parent_url!);
      let channelRules = await getChannelRules(channel?.id!);
      const userAddresses = cast.author.verified_addresses.eth_addresses;
      let membershipIsValidForAtLeastOneAddress = await doAddressesHaveValidMembershipInRules(userAddresses, channelRules);

      if (membershipIsValidForAtLeastOneAddress) {
        let castReactionResponse = await neynarClient.publishReactionToCast(process.env.SIGNER_UUID!, ReactionType.Like, castHash);
        if (castReactionResponse.success) {
          return c.json({ message: statusMessage[ApiRoute.HOOK_VALIDATE][HookValidateResult.CAST_REACTION_SUCCESS] });
        } else {
          return c.json({ message: statusMessage[ApiRoute.HOOK_VALIDATE][HookValidateResult.CAST_REACTION_ERROR] });
        }
      } else {
        // Determine if the user has no NFT or if the user has an NFT but it's expired
        let totalKeysCount = await getLockTotalKeys(userAddresses[0], channelRules[0].contract_address, channelRules[0].network);
        if (totalKeysCount == 0) {
          // if no keys then no nft, so suggest cast owner to buy a new key of the lock
        } else {
          // One or more keys are expired, so let's renew the first we found
          let isOwnerOfToken = await getTokenOfOwnerByIndex(userAddresses[0], 0, channelRules[0].contract_address, channelRules[0].network);
        }
        let message = `Hey @${username}, it looks like you don't have a subscription yet. Let me help you with that.`;
        const castResponse = await neynarClient.publishCast(
          process.env.SIGNER_UUID!,
          message,
          {
            embeds: [
              {
                url: `${process.env.APP_URL}/api/9c3d6b6c-d3d1-424e-a5f0-b2489a68fbed`, // Get at https://app.unlock-protocol.com/locks/checkout-url
              }]
          }
        );
        console.log("call end: hook-validate");
        if (castResponse.hash) {
          return c.json({ message: statusMessage[ApiRoute.HOOK_VALIDATE][HookValidateResult.CAST_FRAME_SUCCESS] });
        } else {
          return c.json({ message: statusMessage[ApiRoute.HOOK_VALIDATE][HookValidateResult.CAST_FRAME_ERROR] });
        }
      }
    }
  } catch (e) {
    return c.json({ message: statusMessage[ApiRoute.HOOK_VALIDATE][HookValidateResult.ROUTE_ERROR] });
  }
});

app.frame('/frame-setup/:channelId', neynarMiddleware, async (c) => {
  console.log("call start: frame-setup/:channelId");
  console.log("c: ", process.env.NODE_ENV === 'production');
  const { buttonValue, inputText, status, req } = c;
  let ethAddresses: string[] = [];
  let interactorIsChannelLead = false;
  let channelId = req.param('channelId');
  let textFrame = "";
  let dynamicIntents: any[] = [];
  let conditions = 0;

  // Get the channel access rules
  let channelRules = await getChannelRules(channelId!);
  conditions = channelRules?.length ?? 0;

  if (status == "response") {
    // Validate the frame action response and obtain ethAddresses and channelId
    const payload = await req.json();
    console.log("payload: ", payload);
    const frameActionResponse: ValidateFrameActionResponse = await neynarClient.validateFrameAction(payload.trustedData.messageBytes);
    if (frameActionResponse.valid) {
      ethAddresses = frameActionResponse.action.interactor.verified_addresses.eth_addresses;
      let channel = await getChannel(frameActionResponse.action.cast.root_parent_url!);
      let interactor = frameActionResponse.action.interactor?.fid;
      let channelLead = channel?.lead?.fid;
      if (channelLead == interactor) {
        interactorIsChannelLead = true;
      }
      console.log(statusMessage[ApiRoute.FRAME_SETUP][FrameSetupResult.FRAME_ACTION_VALID]);
    } else {
      console.log(statusMessage[ApiRoute.FRAME_SETUP][FrameSetupResult.FRAME_ACTION_INVALID]);
    }
  }

  if (status == "initial" || (status == "response" && buttonValue == "done")) {

    // Step 1: Show the number of rules on the channel
    let lockMetadata;
    if (channelRules?.length! > 0) {
      lockMetadata = await getLockName(channelRules![0].contract_address, channelRules![0].network);
    }
    textFrame = `${channelId} channel has ${conditions == 0 ? "no" : conditions} ${(conditions < 2 ? "rule" : "rules")}.`;

    if (channelRules?.length! == 0) {
      dynamicIntents = [
        <Button value='add'>Add</Button>
      ];
    } else {
      if (conditions >= Number(process.env.ACCESS_RULES_LIMIT)) {
        dynamicIntents = [
          <Button value='remove'>Remove</Button>
        ];
      } else {
        dynamicIntents = [
          <Button value='add'>Add</Button>,
          <Button value='remove'>Remove</Button>
        ];
      }
    }
  } else if (status == "response") {
    if (interactorIsChannelLead) {
      // Step 2: Show action to achieve, either add or remove a rule
      if (buttonValue == "add" || buttonValue == "remove") {
        console.log("step: add or remove");
        if (buttonValue == "add") {
          textFrame = `To add a rule on channel ${channelId}, start by selecting the network the contract is deployed on.`;
          dynamicIntents = [
            <Button value='base'>Base</Button>,
            <Button value='optimism'>Optimism</Button>,
            <Button value='arbitrum'>Arbitrum</Button>
          ];
        } else if (buttonValue == "remove") {
          dynamicIntents = [
          ];
        }
      } else if (buttonValue == "base" || buttonValue == "optimism" || buttonValue == "arbitrum") {

        // Step 3: Show the contract addresses deployed on the selected network
        console.log("step: network selection");
        let network = buttonValue;

        const contractAddresses: string[] = (
          await Promise.all(
            ethAddresses.map(async (ethAddress) =>
              getContractsDeployed(ethAddress, network!)
            )
          )
        ).flat();
        console.log("contractAddresses: ", contractAddresses);

        // we've got the contract addresses, now we need to get if referral is set
        let referralFee = await getMembersOnlyReferralFee(contractAddresses[0], network);
        console.log("referralFee: ", referralFee);
        if (referralFee < process.env.MO_MINIMUM_REFERRAL_FEE!) {
          // do aditional logic here
        }
        // textFrame = `${network}: ${shortenAddress(contractAddresses[0])}`;
        let lockMetadata = await getLockName(channelRules![0].contract_address, channelRules![0].network);
        textFrame = `${network}: ${lockMetadata}`;

        dynamicIntents = [
          <TextInput placeholder="Contract Address..." />,
          <Button value={`page-${network}-0`}>Prev</Button>,
          <Button value={`page-${network}-0`}>Next</Button>,
          <Button value={`confirm-${network}-${contractAddresses[0]}`}>confirm</Button >,
        ];

      } else if (buttonValue!.startsWith("page-")) {
        console.log("step: contract pagination");
        // Step 4: Show the contract address to confirm or write a new one
        let [_, network, page] = buttonValue!.split("-");
        let currentPage = parseInt(page);
        let contractAddresses: string[] = await getContractsDeployed(ethAddresses[currentPage], network);
        let referralFee = await getMembersOnlyReferralFee(contractAddresses[0], network);
        // console.log("referralFee: ", referralFee);
        // if (referralFee < process.env.MO_MINIMUM_REFERRAL_FEE!) {
        //   // do aditional logic here
        // }

        // textFrame = `${network}: ${contractAddresses[currentPage]}`;
        let lockMetadata = await getLockName(channelRules![currentPage].contract_address, channelRules![currentPage].network);
        textFrame = `${network}: ${lockMetadata}`;

        const prevBtn = (index: number) => {
          if (contractAddresses.length > 0 && index > 0) {
            return (<Button value={(index - 1).toString()}>prev</Button>);
          }
        };
        const nextBtn = (index: number) => {
          if (contractAddresses.length > 1 && index < contractAddresses.length) {
            return (<Button value={index.toString()}>next</Button>);
          }
        };

        dynamicIntents = [
          <TextInput placeholder="Contract Address..." />,
          prevBtn(currentPage),
          nextBtn(currentPage),
          <Button value={`confirm-${network}-${contractAddresses[currentPage]}`}>confirm</Button >,
        ];
      } else if (buttonValue!.startsWith("confirm-")) {
        console.log("step: contract confirmation");
        let [_, network, contractAddress] = buttonValue!.split("-");

        // console.log("contractAddress: ", contractAddress);
        console.log("network: ", network);

        let insertError = await insertChannelRule(channelId, network, contractAddress, "AND", "ALLOW");
        if (insertError) {
          console.log("error: ", insertError);
          textFrame = `Error adding the rule.`;
          dynamicIntents = [
            // <TextInput placeholder="Contract Address..." />,
            // prevBtn(currentPage),
            // nextBtn(currentPage),
            <Button value='done'>Complete</Button >,
          ];
        } else {
          textFrame = `Rule added.`;
          dynamicIntents = [
            <Button value={'done'}>Complete</Button>,
          ];
        }
      }
    } else {
      textFrame = "This is a @membersonly frame to configure rules, know more about me at my profile.";
      dynamicIntents = [];
    }
  }
  console.log("call end: frame-setup-channel/:channelId");
  // return c.res({
  //   image: `${process.env.APP_URL}/api/frame-setup-image/${textFrame}`,
  //   intents: dynamicIntents,
  // })
  return c.res({
    image: (
      <div
        style={{
          alignItems: 'center',
          background: 'black',
          backgroundSize: '100% 100%',
          display: 'flex',
          flexDirection: 'column',
          flexWrap: 'nowrap',
          height: '100%',
          justifyContent: 'center',
          textAlign: 'center',
          width: '100%',
        }}
      >
        <div
          style={{
            color: 'white',
            fontSize: 60,
            fontStyle: 'normal',
            letterSpacing: '-0.025em',
            lineHeight: 1.4,
            marginTop: 30,
            padding: '0 120px',
            whiteSpace: 'pre-wrap',
            display: 'flex',
          }}
        >
          {textFrame}
        </div>
      </div>
    ),
    intents: dynamicIntents,
  });
});

app.transaction('/set-referrer-fee/:lockAddress/:feeBasisPoint', (c) => {
  const { req } = c;
  let lockAddress = req.param('lockAddress');
  let feeBasisPoint = req.param('feeBasisPoint');
  return c.contract({
    abi: contracts.PublicLockV14.abi,
    chainId: 'eip155:8453',
    functionName: 'setReferrerFee',
    args: [process.env.MO_ADDRESS, feeBasisPoint],
    to: lockAddress as `0x${string}`
  });
});

// app.image('/frame-setup-image/:customText', (c) => {
//   const { customText } = c.req.param();
//   console.log('/frame-setup-image/:customText', customText);
//   return c.res({
//     image: (
//       <Box
//         grow
//         alignHorizontal="center"
//         backgroundColor="background"
//         padding="32"
//         borderStyle="solid"
//         borderRadius="8"
//         borderWidth="4"
//         borderColor='yellow'
//       >
//         <VStack gap="4">
//           <Heading color={'black'}>@membersonly Channel Bot</Heading>
//           <Spacer size="20" />
//           <Text color={'black'} size="20">
//             {customText}
//           </Text>
//         </VStack>
//       </Box>
//     ),
//   });
// });

//_______________________________________________________________________________________________________________________
// Utils

const getFrameImage = (text: string) => {
  return (
    <Box
      grow
      alignHorizontal="center"
      backgroundColor="background"
      padding="32"
      borderStyle="solid"
      borderRadius="8"
      borderWidth="4"
      borderColor={'yellow'}
    >
      <VStack gap="4">
        <Heading color={'black'}>@membersonly Channel Bot</Heading>
        <Spacer size="20" />
        <Text color={'black'} size="20">
          {text}
        </Text>
      </VStack>
    </Box>
  );
}

const getDistinctAddresses = async (fid: string): Promise<Address[]> => {
  let fetchedUsers: any = await neynarClient.fetchBulkUsers([Number(fid)]);
  const ethAddresses: string[] = fetchedUsers.users[0]?.verified_addresses?.eth_addresses;
  return Array.from(new Set(
    (ethAddresses || [])
      .filter(address => typeof address === 'string' && address.startsWith('0x'))
      .map(address => address as Address)
  ));
};

const shortenAddress = (address: string): string => {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "";
};

function isSetupCast(castText: string): boolean {
  // Conditional text has been set in the hook, but it's also validated here
  return castText.trim().toLowerCase() === process.env.BOT_SETUP_TEXT!.toLowerCase(); // Case-insensitive check
}

function getLastPartOfUrl(url: string) {
  const urlObj = new URL(url);
  const parts = urlObj.pathname.split('/');
  return parts[parts.length - 1];
}

const getContractsDeployed = async (address: string, network: string): Promise<string[]> => {
  let alchemyRpc = getAlchemyRpc(network);
  console.log("rpc: ", alchemyRpc);
  try {
    const txWithProxy = await fetch(alchemyRpc, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "alchemy_getAssetTransfers",
        params: [
          {
            fromBlock: "0x0",
            toBlock: "latest",
            fromAddress: address,
            toAddress: getUnlockProxyAddress(network),
            category: ["external"],
            order: "desc",
            withMetadata: true,
            excludeZeroValue: false // it needs to include zero values
          },
        ],
      }),
      next: {
        revalidate: 600,
      },
    });
    const txWithProxyData = await txWithProxy.json();
    const txHashes: string[] = txWithProxyData.result.transfers.map((tx: any) => tx.hash);
    const allReceiptPromises = await Promise.all(
      txHashes.map(async (txHash: string) => {
        const response = await fetch(alchemyRpc, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "eth_getTransactionReceipt",
            params: [txHash],
          }),
          next: {
            revalidate: 600,
          },
        });

        if (!response.ok) {
          throw new Error(`Request for hash ${txHash} failed`);
        }

        const data = await response.json();
        return data?.result; // Extract the receipts from the response
      })
    );
    const allReceipts = await Promise.all(allReceiptPromises);
    const contractAddresses = allReceipts.flatMap((receipt) => {
      if (receipt.logs && receipt.logs.length > 0) {
        const firstLog = receipt.logs[0]; // There could be logs that have a different address, but I'm assuming the first one is the contract address
        return firstLog.address;
      } else {
        return [];
      }
    });
    return contractAddresses;
  } catch (error) {
    console.error("Error in getContractsDeployed requests:", error);
    return [];
  }
}

const getChannel = async (rootParentUrl: string): Promise<Channel | null> => {
  // let channelId = getLastPartOfUrl(rootParentUrl);
  // let channels: Array<Channel> = (await neynarClient.searchChannels(channelId)).channels;
  let channels: Array<Channel> = (await neynarClient.fetchBulkChannels([rootParentUrl], { type: ChannelType.ParentUrl })).channels;
  if (channels && channels.length > 0) {
    return channels[0];
  } else {
    return null;
  }
}

devtools(app, { serveStatic })

export const GET = handle(app)
export const POST = handle(app)