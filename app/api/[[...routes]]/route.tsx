/** @jsxImportSource frog/jsx */

import { Button, Frog, TextInput } from 'frog';
import { Box, Divider, Heading, Text, VStack, Rows, Row, Spacer, vars } from '@/app/utils/frog/ui';
import { devtools } from 'frog/dev';
import { neynar, type NeynarVariables } from 'frog/middlewares';
import { handle } from 'frog/next';
import { serveStatic } from 'frog/serve-static';
import neynarClient, { getEipChainId } from '@/app/utils/neynar/client';
import { Cast, Channel, ChannelType, ReactionType, ValidateFrameActionResponse } from '@neynar/nodejs-sdk/build/neynar-api/v2';
import { Address } from 'viem';
import { deleteChannelRule, doesRuleWithContractExist, getChannelRules, insertChannelRule } from '@/app/utils/supabase/server';
import { getContractsDeployed } from '@/app/utils/alchemy/constants';
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
  FRAME_PURCHASE = "FRAME-PURCHASE/:CHANNELID",
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

enum FramePurchaseResult {
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
  [ApiRoute.FRAME_PURCHASE]: {
    [FramePurchaseResult.FRAME_ACTION_VALID]: `${ApiRoute.FRAME_PURCHASE} => FRAME ACTION IS VALID`,
    [FramePurchaseResult.FRAME_ACTION_INVALID]: `${ApiRoute.FRAME_PURCHASE} => FRAME ACTION IS INVALID`,
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
        let textCast = '';
        // Determine if the user has no NFT or if the user has an NFT but it's expired
        let totalKeysCount = await getLockTotalKeys(userAddresses[0], channelRules[0].contract_address, channelRules[0].network);
        if (totalKeysCount == 0) {
          // if no keys then no nft, so suggest cast owner to buy a new key of the lock
          textCast = `Hey @${username}, it looks like you don't have a key to access ${channel?.id} channel yet. Let me help you with that.`;
        } else {
          // One or more keys are expired, so let's renew the first we found
          textCast = `Hey @${username}, it looks like you have an expired key to access ${channel?.id} channel. Let me help you with that.`;
          let isOwnerOfToken = await getTokenOfOwnerByIndex(userAddresses[0], 0, channelRules[0].contract_address, channelRules[0].network);
        }
        const castResponse = await neynarClient.publishCast(
          process.env.SIGNER_UUID!,
          textCast,
          {
            embeds: [
              {
                url: `${process.env.APP_URL}/api/frame-purchase/${channel?.id}`, // Get at https://app.unlock-protocol.com/locks/checkout-url
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

app.frame('/frame-purchase/:channelId', neynarMiddleware, async (c) => {
  console.log("call start: frame-purchase/:channelId");
  const { buttonValue, inputText, status, req } = c;
  let ethAddresses: string[] = [];
  let channelId = req.param('channelId');
  let textFrame = "";
  let dynamicIntents: any[] = [];
  let conditions = 0;
  let membershipIsValidForAtLeastOneAddress = true;
  let totalKeysCount = 0;

  // Get the channel access rules
  let channelRules = await getChannelRules(channelId!);

  if (status == "initial" || (status == "response" && buttonValue == "done")) {

    textFrame = `To purchase or renew your key to access ${channelId} channel, let's start by veryfing some data.`;
    // Step 1: Show the number of rules on the channel
    let lockMetadata = '';
    if (channelRules?.length! > 0) {
      lockMetadata = await getLockName(channelRules![0].contract_address, channelRules![0].network);
    }
    dynamicIntents = [
      <Button value='verify'>verify</Button>
    ];

  } else if (status == "response") {
    const payload = await req.json();
    if (process.env.NODE_ENV === 'production') {
      const frameActionResponse: ValidateFrameActionResponse = await neynarClient.validateFrameAction(payload.trustedData.messageBytes);
      if (frameActionResponse.valid) {
        ethAddresses = frameActionResponse.action.interactor.verified_addresses.eth_addresses;
        let channel = await getChannel(frameActionResponse.action.cast.root_parent_url!);
        console.log(statusMessage[ApiRoute.FRAME_PURCHASE][FramePurchaseResult.FRAME_ACTION_VALID]);
      } else {
        console.log(statusMessage[ApiRoute.FRAME_PURCHASE][FramePurchaseResult.FRAME_ACTION_INVALID]);
      }
    } else {
      // For local development
      ethAddresses = ["0xe8f5533ba4C562b2162e8CF9B769A69cd28e811D"];
    }

    // Verify there's at least one rule
    if (channelRules.length > 0) {
      // Verify the user doesn't have a valid membership
      membershipIsValidForAtLeastOneAddress = await doAddressesHaveValidMembershipInRules(ethAddresses, channelRules);
      if (membershipIsValidForAtLeastOneAddress) {
        textFrame = `You already have a valid key to access ${channelId} channel. So just keep casting on your favorite channel!`;
        dynamicIntents = [
          <Button value='done'>complete</Button>
        ];
      } else {
        // Verify the user doesn't have an expired membership
        let keyCounts = await Promise.all(
          ethAddresses.map((ethAddress) =>
            getLockTotalKeys(ethAddress, channelRules[0].contract_address, channelRules[0].network)
          )
        );
        let totalKeysCount = keyCounts.reduce((sum, count) => sum + Number(count), 0);
        if (!membershipIsValidForAtLeastOneAddress && totalKeysCount == 0) {
          // Then the user has no keys, so let's suggest to buy a new key
          textFrame = `You don't have a key to access ${channelId} channel. Let's mint one:`;
          dynamicIntents = [
            <Button value='done'>back</Button>,
            // '/tx-purchase/:lockAddress/:network'
            <Button.Transaction target={`/tx-purchase/${channelRules[0].contract_address}/${channelRules[0].network}`}>buy</Button.Transaction>
          ];
        } else {
          // One or more keys are expired, so let's renew the first we found
          // let isOwnerOfToken = await getTokenOfOwnerByIndex(ethAddresses[0], 0, channelRules[0].contract_address, channelRules[0].network);
          let tokenId = 0;
          textFrame = `You have an expired key. Let's renew it:`;
          dynamicIntents = [
            <Button value='done'>back</Button>,
            // /tx-renew/:lockAddress/:network/:tokenId
            <Button.Transaction target={`/tx-renew/${channelRules[0].contract_address}/${channelRules[0].network}/${tokenId}`}>renew</Button.Transaction>
          ];
        }
      }
    }
  }

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
  let channelRules: { id: Number, channel_id: string, network: string, contract_address: string }[] = await getChannelRules(channelId!);
  conditions = channelRules?.length ?? 0;

  if (status == "response") {
    // Validate the frame action response and obtain ethAddresses and channelId
    const payload = await req.json();
    if (process.env.NODE_ENV === 'production') {
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
    } else {
      // For local development
      ethAddresses = ["0xe8f5533ba4C562b2162e8CF9B769A69cd28e811D"];
      interactorIsChannelLead = true;
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
        <Button value='add'>add</Button>
      ];
    } else {
      if (conditions >= Number(process.env.ACCESS_RULES_LIMIT)) {
        dynamicIntents = [
          <Button value='remove'>remove</Button>
        ];
      } else {
        dynamicIntents = [
          <Button value='add'>add</Button>,
          <Button value='remove'>remove</Button>
        ];
      }
    }
  } else if (status == "response") {
    if (interactorIsChannelLead) {
      // Step 2: Show action to achieve, either add or remove a rule
      if (buttonValue == "add" || buttonValue == "remove") {
        console.log("add or remove selection: start");
        if (buttonValue == "add") {
          textFrame = `To add a rule on channel ${channelId}, start by selecting the network the contract is deployed on.`;
          dynamicIntents = [
            <Button value='base'>base</Button>,
            <Button value='optimism'>optimism</Button>,
            <Button value='arbitrum'>arbitrum</Button>
          ];
        } else if (buttonValue == "remove") {
          const nextBtn = (index: number) => {
            if (channelRules.length > 1 && index) {
              return (<Button value={`removepage-${index}`}>next</Button>);
            }
          };
          if (channelRules?.length! == 0) {
            textFrame = `There are no rules to remove on channel ${channelId}.`;
            dynamicIntents = [
              <Button value='done'>back</Button>
            ];
          } else {
            let firstContractAddress = channelRules[0].contract_address;
            let lockMetadata = await getLockName(channelRules[0].contract_address, channelRules[0].network);
            if (lockMetadata) {
              textFrame = `${channelRules[0].network}: ${lockMetadata}`;
            } else {
              textFrame = `${channelRules[0].network}: ${shortenAddress(channelRules[0].contract_address)}`;
            }
            dynamicIntents = [
              nextBtn(1),
              <Button value={`removeconfirm-${firstContractAddress}`}>confirm remove</Button >,
            ];
          }
        }
        console.log("add or remove selection: end");
      } else if (buttonValue == "base" || buttonValue == "optimism" || buttonValue == "arbitrum") {
        console.log("network selection: start");
        // Step 3: Show the contract addresses deployed on the selected network
        let network = buttonValue;
        const contractAddresses: string[] = (
          await Promise.all(
            ethAddresses.map(async (ethAddress) =>
              getContractsDeployed(ethAddress, network)
            )
          )
        ).flat();
        console.log("networks => contractAddresses: ", contractAddresses);

        if (contractAddresses.length > 0) {
          let lockMetadata = await getLockName(contractAddresses[0], network);
          textFrame = `${network}: ${lockMetadata}`;
          // we've got the contract addresses, now we need to get if referral is set
          // let referralFee = await getMembersOnlyReferralFee(contractAddresses[0], network);
          // if (referralFee < process.env.MO_MINIMUM_REFERRAL_FEE!) {
          //   textFrame = `The referral fee is below the minimum required. Please set at least ${process.env.MO_MINIMUM_REFERRAL_FEE!} basis points.`;
          //   // do aditional logic here
          // }
        } else {
          textFrame = "No lock found deployed from your accounts, please set one on the input and click confirm.";
        }

        const nextBtn = (index: number) => {
          if (contractAddresses.length > 1 && index < (contractAddresses.length - 1)) {
            return (<Button value={`addpage-${network}-${index + 1}`}>next</Button>);
          }
        };

        dynamicIntents = [
          <TextInput placeholder="Contract Address..." />,
          <Button value={'done'}>back</Button >,
          nextBtn(0),
          <Button value={`addconfirm-${network}-${(contractAddresses.length > 0) ? contractAddresses[0] : process.env.ZERO_ADDRESS}`}>confirm add</Button >,
        ];
        console.log("network selection: end");
      } else if (buttonValue!.startsWith("addpage-")) {
        console.log("addpage-: start");
        // Step 4: Show the contract address to confirm or write a new one
        let [_, network, page] = buttonValue!.split("-");
        let currentPage = parseInt(page);
        const contractAddresses: string[] = (
          await Promise.all(
            ethAddresses.map(async (ethAddress) =>
              getContractsDeployed(ethAddress, network)
            )
          )
        ).flat();

        // let referralFee = await getMembersOnlyReferralFee(contractAddresses[currentPage], network);
        // console.log("referralFee: ", referralFee);
        // if (referralFee < process.env.MO_MINIMUM_REFERRAL_FEE!) {
        //   // do aditional logic here
        // }

        let lockMetadata = await getLockName(contractAddresses[currentPage], network);
        textFrame = `${network}: ${lockMetadata}`;

        const prevBtn = (index: number) => {
          if (contractAddresses.length > 0 && index > 0) {
            console.log("addpage-: prevBtn");
            console.log("addpage-: index", index);
            console.log("addpage-: contractAddresses", contractAddresses);
            return (<Button value={`addpage-${network}-${index - 1}`}>prev</Button>);
          }
        };
        const nextBtn = (index: number) => {
          if (contractAddresses.length > (index + 1)) {
            return (<Button value={`addpage-${network}-${index + 1}`}>next</Button>);
          }
        };

        dynamicIntents = [
          <TextInput placeholder="Contract Address..." />,
          prevBtn(currentPage),
          nextBtn(currentPage),
          <Button value={`addconfirm-${network}-${contractAddresses[currentPage]}`}>confirm add</Button >,
        ];
        console.log("addpage-: end");
      } else if (buttonValue!.startsWith("addconfirm-")) {
        console.log("addconfirm-: start");
        let [_, network, contractAddress] = buttonValue!.split("-");
        if (contractAddress == process.env.ZERO_ADDRESS) {
          // if it's zero address, then take the address from the input
          contractAddress = inputText!;
        }
        // Validate there is no rule with the same contract address for this channel
        let ruleExists = await doesRuleWithContractExist(channelId, contractAddress);
        if (ruleExists) {
          textFrame = `A rule with this contract address already exists. Please select another contract address.`;
          dynamicIntents = [
            <TextInput placeholder="Contract Address..." />,
            <Button value={'done'}>back</Button >,
            <Button value={`addconfirm-${network}-${process.env.ZERO_ADDRESS}`}>confirm add</Button >,
          ];
        } else {
          let insertError = await insertChannelRule(channelId, network, contractAddress, "AND", "ALLOW");
          if (insertError) {
            textFrame = `Error adding the rule.`;
            dynamicIntents = [
              <TextInput placeholder="Contract Address..." />,
              <Button value={'done'}>back</Button >,
              <Button value={`addconfirm-${network}-${process.env.ZERO_ADDRESS}`}>try again</Button >,
            ];
          } else {
            textFrame = `Rule added.`;
            dynamicIntents = [
              <Button value={'done'}>complete</Button>,
            ];
          }
        }
        console.log("addconfirm-: end");
      } else if (buttonValue!.startsWith("removepage-")) {
        console.log("removepage-: start");
        // Step 4: Show the contract address to confirm or write a new one
        let [_, page] = buttonValue!.split("-");
        let currentPage = parseInt(page);
        let currentRule = channelRules![currentPage];
        let lockMetadata = await getLockName(currentRule.contract_address, currentRule.network);
        if (lockMetadata) {
          textFrame = `${currentRule.network}: ${lockMetadata}`;
        } else {
          textFrame = `${currentRule.network}: ${shortenAddress(currentRule.contract_address)}`;
        }
        const prevBtn = (index: number) => {
          if (channelRules.length > 0 && index > 0) {
            return (<Button value={`removepage-${index - 1}`}>prev</Button>);
          }
        };
        const nextBtn = (index: number) => {
          if (channelRules.length > (index + 1)) {
            return (<Button value={`removepage-${index + 1}`}>next</Button>);
          }
        };
        dynamicIntents = [
          prevBtn(currentPage),
          nextBtn(currentPage),
          <Button value={`removeconfirm-${currentRule.contract_address}`}>confirm remove</Button >,
        ];
        console.log("removepage-: end");
      } else if (buttonValue!.startsWith("removeconfirm-")) {
        console.log("removeconfirm-: start");
        let [_, contractAddress] = buttonValue!.split("-");
        let deleteError = await deleteChannelRule(channelId, contractAddress);
        if (deleteError) {
          textFrame = `Error adding the rule.`;
          dynamicIntents = [
            <Button value={'done'}>Restart</Button >,
            <Button value={`removeconfirm-${contractAddress}`}>try again</Button >,
          ];
        } else {
          textFrame = `Rule removed.`;
          dynamicIntents = [
            <Button value={'done'}>complete</Button>,
          ];
        }
        console.log("removeconfirm-: end");
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

app.transaction('/tx-referrer-fee/:lockAddress/:network/:feeBasisPoint', (c) => {
  const { req } = c;
  let lockAddress = req.param('lockAddress');
  let network = req.param('network');
  let feeBasisPoint = req.param('feeBasisPoint');
  return c.contract({
    abi: contracts.PublicLockV14.abi,
    chainId: getEipChainId(network),
    functionName: 'setReferrerFee',
    args: [process.env.MO_ADDRESS, feeBasisPoint],
    to: lockAddress as `0x${string}`
  });
});

app.transaction('/tx-purchase/:lockAddress/:network', (c) => {
  const { req } = c;
  let lockAddress = req.param('lockAddress');
  let network = req.param('network');
  return c.contract({
    abi: contracts.PublicLockV14.abi,
    chainId: getEipChainId(network),
    functionName: 'purchase',
    args: [],
    to: lockAddress as `0x${string}`
  });
});

app.transaction('/tx-renew/:lockAddress/:network/:tokenId', (c) => {
  const { req } = c;
  let lockAddress = req.param('lockAddress');
  let network = req.param('network');
  let tokenId = req.param('tokenId');
  return c.contract({
    abi: contracts.PublicLockV14.abi,
    chainId: getEipChainId(network),
    functionName: 'renewMembershipFor',
    args: [
      tokenId,
      process.env.MO_ADDRESS,
    ],
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