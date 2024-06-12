/** @jsxImportSource frog/jsx */

import { Button, Frog, TextInput } from 'frog';
import { devtools } from 'frog/dev';
import { neynar } from 'frog/hubs';
import { handle } from 'frog/next';
import { serveStatic } from 'frog/serve-static';
import neynarClient from '@/app/utils/neynar/client';
import { Cast, Channel, ChannelType, ReactionType, ValidateFrameActionResponse } from '@neynar/nodejs-sdk/build/neynar-api/v2';
import { Address } from 'viem';
import { hasMembership, getLockMetadata, getUnlockProxyAddress, getValidMembershipWithinRules } from '@/app/utils/unlock/membership';
import { getChannelRules, insertChannelRule } from '@/app/utils/supabase/server';
import { getAlchemyRpc } from '@/app/utils/alchemy/constants';
import { getMembersOnlyReferralFee } from '@/app/utils/viem/constants';
import { text } from 'stream/consumers';

const APP_URL = process.env.APP_URL;
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
const BOT_SETUP_TEXT = process.env.BOT_SETUP_TEXT; // @membersonly setup
const ACCESS_RULES_LIMIT = 3;

const app = new Frog({
  assetsPath: '/',
  basePath: '/api',
  origin: process.env.APP_URL,
  hub: neynar({ apiKey: NEYNAR_API_KEY! }),
  imageOptions: {
    format: "svg",
  },
  verify: process.env.NODE_ENV === 'production' // leave it as is, if not issue with frog local debug tool
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
    // console.log("cast root_parent_url: ", cast.root_parent_url!);
    let channel = await getChannel(cast.root_parent_url!);
    let channelId = channel?.id;
    let channelLead = channel?.lead?.fid;

    // 1.2 Get the cast author
    let castAuthor = cast.author.fid;

    // 1.3 Compare the channel owner and the cast author and validate the cast text is "@membersonly setup"
    // Probably second validation will be removed and just validated on the hook
    let castText = cast.text;

    // console.log("call start: hook-setup => castAuthor == castText");
    if (channelLead == castAuthor && castText == BOT_SETUP_TEXT) {
      console.log("url to embed on reply cast: ", `${APP_URL}/api/frame-setup/${channelId}`);
      const castResponse = await neynarClient.publishCast(
        process.env.SIGNER_UUID!,
        "",
        {
          replyTo: cast.hash,
          embeds: [
            {
              url: `${APP_URL}/api/frame-setup/${channelId}`,
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
    // console.log("body: ", body);

    if (!isSetupCast(cast.text)) {
      let fid = cast.author.fid;
      let username = body.data.author.username;
      let castHash = body.data.hash;
      // console.log("channelRules: ", channelRules);
      let channel = await getChannel(cast.root_parent_url!);
      let channelRules = await getChannelRules(channel?.id!);
      const userAddresses = cast.author.verified_addresses.eth_addresses;
      let validMembership = await getValidMembershipWithinRules(channelRules, userAddresses);
      // let validMembership = true;

      if (validMembership) {
        let castReactionResponse = await neynarClient.publishReactionToCast(process.env.SIGNER_UUID!, ReactionType.Like, castHash);
        console.log("Cast reaction successful:", castReactionResponse);
        return c.json({ message: "Cast reaction successful!" });
      } else {
        let message = `Hey @${username}, it looks like you don't have a subscription yet. Let me help you with that.`;
        const castResponse = await neynarClient.publishCast(
          process.env.SIGNER_UUID!,
          message,
          {
            embeds: [
              {
                url: `${APP_URL}/api/9c3d6b6c-d3d1-424e-a5f0-b2489a68fbed`, // Get at https://app.unlock-protocol.com/locks/checkout-url
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

app.frame('/frame-setup/:channelId', async (c) => {
  console.log("call start: frame-setup/:channelId");
  const { buttonValue, inputText, status, req } = c;
  console.log("req: ", req);
  let ethAddresses: string[] = [];
  // try {
  const body = await req.json();
  console.log("body: ", body);
  let cast: Cast = body.data;
  console.log("cast: ", cast);
  // ethAddresses = cast.author.verified_addresses.eth_addresses;
  //   console.log("ethAddresses: ", ethAddresses);
  // } catch (error) {
  //   console.log("error: ", error);
  // }
  // const payload = await req.json();

  let channelId = req.param('channelId');
  // console.log("channelId: ", channelId);
  let dynamicIntents: any[] = [];
  let textFrame = "";
  let conditions = 0;

  let interactorIsChannelLead = true;

  // Validate the frame action response and obtain ethAddresses and channelId
  // const frameActionResponse: ValidateFrameActionResponse = await neynarClient.validateFrameAction(payload.trustedData.messageBytes);
  // console.log("frameActionResponse: ", frameActionResponse);
  // if (frameActionResponse.valid) {
  //   ethAddresses = frameActionResponse.action.interactor.verified_addresses.eth_addresses;
  //   let channel = await getChannel(frameActionResponse.action.cast.root_parent_url!);
  //   let frameChannelId = channel?.id!;
  //   let interactor = frameActionResponse.action.signer?.client?.fid;
  //   let channelLead = channel?.lead?.fid;
  //   if (channelLead == interactor) {
  //     interactorIsChannelLead = true;
  //   }
  // }

  ethAddresses = ["0xe8f5533ba4C562b2162e8CF9B769A69cd28e811D"];
  // console.log("buttonValue: ", buttonValue);

  if (interactorIsChannelLead) {
    // Get the channel access rules
    let channelRules = await getChannelRules(channelId!);
    conditions = channelRules!.length;

    if (status == "initial" || (status == "response" && buttonValue == "done")) {
      // Step 1: Show the number of rules on the channel
      console.log("step: initial");
      let lockMetadata;
      if (channelRules?.length! > 0) {
        lockMetadata = getLockMetadata(channelRules![0].contract_address, channelRules![0].network);
      }
      textFrame = `${channelId} channel has ${conditions == 0 ? "no" : conditions} rules`;
      if (channelRules?.length! == 0) {
        dynamicIntents = [
          <Button value='add'>Add</Button>
        ];
      } else {
        if (conditions >= ACCESS_RULES_LIMIT) {
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
    }

    if (status == "response") {
      console.log("status: ", status);
      console.log("buttonValue: ", buttonValue);
      // Step 2: Show action to achieve, either add or remove a rule
      if (buttonValue == "add" || buttonValue == "remove") {
        console.log("step: add or remove");
        if (buttonValue == "add") {
          let firstPage = 0;
          textFrame = `To add a rule on channel ${channelId}, start by selecting the network the contract is deployed on.`;
          dynamicIntents = [
            <Button value='base'>Base</Button>,
            <Button value='optimism'>Optimism</Button>,
            <Button value='arbitrum'>Arbitrum</Button>
          ];
        } else if (buttonValue == "remove") {
          // maybe just remove
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
        let referralFee = await getMembersOnlyReferralFee(contractAddresses[0]);
        console.log("referralFee: ", referralFee);
        if (referralFee < process.env.MO_MINIMUM_REFERRAL_FEE!) {
          // do aditional logic here
        }
        textFrame = `${network}: ${contractAddresses[0]}`;

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
        let referralFee = await getMembersOnlyReferralFee(contractAddresses[0]);
        // console.log("referralFee: ", referralFee);
        // if (referralFee < process.env.MO_MINIMUM_REFERRAL_FEE!) {
        //   // do aditional logic here
        // }

        textFrame = `${network}: ${contractAddresses[currentPage]}`;

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

        console.log("contractAddress: ", contractAddress);
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
    }
  } else {
    textFrame = "This is a @membersonly frame to configure rules, know more about me at my profile.";
    dynamicIntents = [];
  }
  console.log("call end: frame-setup-channel/:channelId");
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
  })
});

//_______________________________________________________________________________________________________________________
// Utils

const getDistinctAddresses = async (fid: string): Promise<Address[]> => {
  let fetchedUsers: any = await neynarClient.fetchBulkUsers([Number(fid)]);
  const ethAddresses: string[] = fetchedUsers.users[0]?.verified_addresses?.eth_addresses;
  return Array.from(new Set(
    (ethAddresses || [])
      .filter(address => typeof address === 'string' && address.startsWith('0x'))
      .map(address => address as Address)
  ));
};

function isSetupCast(castText: string): boolean {
  // Conditional text has been set in the hook, but it's also validated here
  return castText.trim().toLowerCase() === BOT_SETUP_TEXT!.toLowerCase(); // Case-insensitive check
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
    // console.log("allReceipts: ", allReceipts);
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
  console.log("getChannel");
  console.log("getChannel - rootParentUrl: ", rootParentUrl);
  let channelId = getLastPartOfUrl(rootParentUrl);
  console.log("getChannel - channelId: ", channelId);
  // let channels: Array<Channel> = (await neynarClient.fetchBulkChannels([rootParentUrl], { type: ChannelType.ParentUrl })).channels;
  let channels: Array<Channel> = (await neynarClient.searchChannels(channelId)).channels;
  console.log("getChannel - after");

  if (channels && channels.length > 0) {
    console.log("getChannel - channels[0]: ", channels[0]);
    return channels[0];
  } else {
    return null;
  }
}

devtools(app, { serveStatic })

export const GET = handle(app)
export const POST = handle(app)