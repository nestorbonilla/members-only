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
import { getUnlockProxyAddress } from '@/app/utils/unlock/membership';
import { getChannelRules, insertChannelRule } from '@/app/utils/supabase/server';
import { getAlchemyRpc } from '@/app/utils/alchemy/constants';
import { doAddressesHaveValidMembershipInRules, getLockName, getMembersOnlyReferralFee } from '@/app/utils/viem/constants';

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

app.hono.post("/hook-setup", async (c) => {
  try {
    console.log("call start: hook-setup");

    const body = await c.req.json();
    let cast: Cast = body.data;
    console.log("cast text: ", cast.text);

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

    // console.log("call start: hook-setup => castAuthor == castText");
    if (channelLead == castAuthor && castText == process.env.BOT_SETUP_TEXT) {
      console.log("url to embed on reply cast: ", `${process.env.APP_URL}/api/frame-setup/${channelId}`);
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
        console.log("call end: hook-setup");
        return c.json({ message: 'Cast sent.' }, 200);
      } else {
        return c.json({ message: 'Error casting message.' }, 200);
      }

    } else {
      console.log("call end: hook-setup");
      return c.json({ message: "You are not the owner of this channel." }, 200);
    }
  } catch (e) {
    console.error("Error:", e);
    return c.json({ message: "Error processing request." }, 200);
  }

});

app.hono.post("/hook-validate", async (c) => {
  try {
    console.log("call start: hook-validate");
    const body = await c.req.json();
    let cast: Cast = body.data;

    if (!isSetupCast(cast.text)) {
      let username = body.data.author.username;
      let castHash = body.data.hash;
      let channel = await getChannel(cast.root_parent_url!);
      let channelRules = await getChannelRules(channel?.id!);
      const userAddresses = cast.author.verified_addresses.eth_addresses;
      let membershipIsValidForAtLeastOneAddress = await doAddressesHaveValidMembershipInRules(userAddresses, channelRules);

      if (membershipIsValidForAtLeastOneAddress) {
        let castReactionResponse = await neynarClient.publishReactionToCast(process.env.SIGNER_UUID!, ReactionType.Like, castHash);
        console.log("Cast reaction successful:", castReactionResponse);
        return c.json({ message: "Cast reaction successful!" });
      } else {
        // Determine if the user has no NFT or if the user has an NFT but it's expired

        // Has one of the addresses an expired membership?


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
        if (!castResponse.hash) {
          return c.json({ message: 'Error casting message.' }, 500);
        }
        //   const castData = (await castResponse).text;
        //   console.log("Cast successful:", castData);
        console.log("call end: hook-validate");
        return c.json({ message: "Cast successful!" });

      }
    } else {
      return c.json({ message: "Setup cast." }, 200);
    }
  } catch (e) {
    console.error("Error:", e);
    return c.json({ message: "Error processing request." }, 500);
  }
});

app.frame('/frame-setup/:channelId', neynarMiddleware, async (c) => {
  console.log("call start: frame-setup/:channelId");
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
    const frameActionResponse: ValidateFrameActionResponse = await neynarClient.validateFrameAction(payload.trustedData.messageBytes);
    if (frameActionResponse.valid) {
      ethAddresses = frameActionResponse.action.interactor.verified_addresses.eth_addresses;
      let channel = await getChannel(frameActionResponse.action.cast.root_parent_url!);
      let interactor = frameActionResponse.action.interactor?.fid;
      let channelLead = channel?.lead?.fid;
      if (channelLead == interactor) {
        interactorIsChannelLead = true;
      }
      console.log("Frame action response is valid.")
    } else {
      console.log("Frame action response is invalid.")
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
  return c.res({
    image: `${process.env.APP_URL}/api/frame-setup-image/${textFrame}`,
    intents: dynamicIntents,
  })
});

app.image('/frame-setup-image/:customText', (c) => {
  const { customText } = c.req.param();
  console.log('/frame-setup-image/:customText', customText);
  return c.res({
    image: (
      <Box
        grow
        alignHorizontal="center"
        backgroundColor="background"
        padding="32"
        borderStyle="solid"
        borderRadius="8"
        borderWidth="4"
        borderColor='yellow'
      >
        <VStack gap="4">
          <Heading color={'black'}>@membersonly Channel Bot</Heading>
          <Spacer size="20" />
          <Text color={'black'} size="20">
            {customText}
          </Text>
        </VStack>
      </Box>
    ),
  });
});
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