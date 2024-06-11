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
      console.log("url to embed on reply cast: ", `${APP_URL}/api/frame-setup-channel/${channelId}`);
      const castResponse = await neynarClient.publishCast(
        process.env.SIGNER_UUID!,
        "",
        {
          replyTo: cast.hash,
          embeds: [
            {
              url: `${APP_URL}/api/frame-setup-channel/${channelId}`,
            }]
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

app.frame('/', (c) => {
  console.log("call start: /");
  const channelId = 'unlock';
  console.log("call end: /");
  return c.res({
    image: (
      <div style={{ color: 'white', display: 'flex', fontSize: 60 }}>
        Hey simple
      </div>
    ),
    intents: [],
  })
});

app.frame('/with-async', async (c) => {
  console.log("call start: /");
  const channelId = 'unlock';
  console.log("call end: /");
  return c.res({
    image: (
      <div style={{ color: 'white', display: 'flex', fontSize: 60 }}>
        Hey async
      </div>
    ),
    intents: [],
  })
});

app.frame('/with-async-param/:channelId', async (c) => {
  console.log("call start: /");
  const { req } = c;
  const channelId = req.param('channelId');
  console.log("channelId: ", channelId);
  console.log("call end: /");
  return c.res({
    image: (
      <div style={{ color: 'white', display: 'flex', fontSize: 60 }}>
        Hey async with param {channelId}
      </div>
    ),
    intents: [],
  })
});

app.frame('/frame-setup-channel/:channelId', async (c) => {
  console.log("call start: frame-setup-channel/:channelId");
  const { req } = c;

  const channelId = req.param('channelId');

  let dynamicIntents = [];
  let nextFrame = "frame-setup-channel-action";
  let prevFrame = "/";
  let conditions = 0;

  // Get the channel access rules
  let channelRules = await getChannelRules(channelId!);
  if (channelRules?.length! > 0) {
    conditions = channelRules!.length;
    console.log("conditions: ", conditions);
    if (conditions >= ACCESS_RULES_LIMIT) {
      dynamicIntents = [
        <Button action={`/${nextFrame}/${channelId}/remove`}>Remove</Button>
      ];
    } else {
      dynamicIntents = [
        <Button action={`/${nextFrame}/${channelId}/add`}>Add</Button>,
        <Button action={`/${nextFrame}/${channelId}/remove`}>Remove</Button>
      ];
    }
  } else {
    dynamicIntents = [
      <Button action={`/${nextFrame}/${channelId}/add`}>Add</Button>
    ];
  }

  console.log("call end: frame-setup-channel/:channelId");
  return c.res({
    headers: {
      'Content-Type': 'image/svg+xml',
    },
    // image: (
    //   <div
    //     style={{
    //       alignItems: 'center',
    //       background: 'black',
    //       backgroundSize: '100% 100%',
    //       display: 'flex',
    //       flexDirection: 'column',
    //       flexWrap: 'nowrap',
    //       height: '100%',
    //       justifyContent: 'center',
    //       textAlign: 'center',
    //       width: '100%',
    //     }}
    //   >
    //     <div
    //       style={{
    //         color: 'white',
    //         fontSize: 60,
    //         fontStyle: 'normal',
    //         letterSpacing: '-0.025em',
    //         lineHeight: 1.4,
    //         marginTop: 30,
    //         padding: '0 120px',
    //         whiteSpace: 'pre-wrap',
    //         display: 'flex',
    //       }}

    //     >
    //       {channelId} channel has {conditions == 0 ? "no" : conditions} rules
    //     </div>
    //   </div>
    // ),
    // imageOptions: {
    //   format: "svg",
    // },
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
          textAlign: 'center'
        }}
      >
        Hi {channelId}
      </div>
    ),
    intents: dynamicIntents,
  })
});

app.frame('/frame-setup-channel-action/:channelId/:action', async (c) => {
  console.log("call start: frame-channel-action/:channelId/:action");
  const channelId = c.req.param('channelId');
  const action = c.req.param('action');
  console.log("channelId and action: ", channelId, action);

  let dynamicIntents = [];
  let nextFrame = "";
  let prevFrame = "frame-setup-channel";
  let firstPage = 0;

  if (action == "add") {
    nextFrame = "frame-setup-contract";
    dynamicIntents = [
      <Button action={`/${nextFrame}/base/${firstPage}`}>Base</Button>,
      <Button action={`/${nextFrame}/optimism/${firstPage}`}>Optimism</Button>,
      <Button action={`/${nextFrame}/arbitrum/${firstPage}`}>Arbitrum</Button>,
      <Button action={`/${nextFrame}/other/${firstPage}`}>Other</Button>,
    ];
    console.log("call end: frame-channel-action/:channelId/:action");
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
            To add a rule on channel {channelId}, start by selecting the network the contract is deployed on.
          </div>
        </div>
      ),
      intents: dynamicIntents,
    })
  } else //if (action == "remove")
  {
    nextFrame = "frame-setup-remove";
    dynamicIntents = [
      <Button action={`/${nextFrame}/base/${firstPage}`}>Prev</Button>,
      <Button action={`/${nextFrame}/optimism/${firstPage}`}>Next</Button>,
      <Button action={`/${nextFrame}/arbitrum/${firstPage}`}>Confirm</Button>
    ];
    console.log("call end: frame-channel-action/:channelId/:action");
    let conditions = 0;
    // Get the channel access rules
    let channelRules = await getChannelRules(channelId);
    if (channelRules?.length! > 0) {
      conditions = channelRules!.length;
    }
    console.log("call end: frame-channel/:channelId");
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
            Is this the rule you want to remove from channel {channelId}?
          </div>
        </div>
      ),
      intents: dynamicIntents,
    })
  }
});

app.frame('/frame-setup-contract/:network/:page', async (c) => {
  console.log("call start: frame-setup-contract/:network/:page");
  const { buttonValue, inputText, status, req } = c;
  const payload = await req.json();
  // console.log("payload: ", payload);
  let nextFrame = "";
  let dynamicIntents = [];
  const network = c.req.param('network');
  const page = c.req.param('page');
  let currentPage = parseInt(page!);
  // console.log("chain and page: ", network, page);
  let textFrame = "";
  let channelId = "";
  let ethAddresses: string[] = [];

  // console.log("messageBytes: ", payload.trustedData.messageBytes);
  // Validate the frame action response and obtain ethAddresses and channelId
  const frameActionResponse: ValidateFrameActionResponse = await neynarClient.validateFrameAction(payload.trustedData.messageBytes);
  console.log("frameActionResponse: ", frameActionResponse);
  if (frameActionResponse.valid) {
    ethAddresses = frameActionResponse.action.interactor.verified_addresses.eth_addresses;
    let channel = await getChannel(frameActionResponse.action.cast.root_parent_url!);
    channelId = channel?.id!;
  }
  const contractAddresses: string[] = (
    await Promise.all(
      ethAddresses.map(async (ethAddress) =>
        getContractsDeployed(ethAddress, network!)
      )
    )
  ).flat();
  console.log("contractAddresses: ", contractAddresses);

  // we've got the contract addresses, now we need to get if referral is set
  let referralFee = await getMembersOnlyReferralFee(contractAddresses[currentPage]);
  console.log("referralFee: ", referralFee);
  if (referralFee < process.env.MO_MINIMUM_REFERRAL_FEE!) {
    // do aditional logic here
  }

  // this is failing with 'could not detect network'
  // let getLockMetadataPromises = contractAddresses.map(async (contractAddress) => {
  //   return await getLockMetadata(contractAddress, network);
  // });
  // let lockMetadata = await Promise.all(getLockMetadataPromises);

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

  if (status == "response" && buttonValue == "done" && inputText) {
    console.log("inputText: ", inputText);
    // Get the channel access rules
    let insertError = await insertChannelRule(channelId, network, inputText, "AND", "ALLOW");

    if (insertError) {
      console.log("error: ", insertError);
      textFrame = `Error adding the rule.`;
      dynamicIntents = [
        <TextInput placeholder="Contract Address..." />,
        prevBtn(currentPage),
        nextBtn(currentPage),
        <Button value='done'>confirm</Button >,
      ];
    } else {
      textFrame = `Rule added.`;
      let nextFrame = "frame-setup-channel";
      dynamicIntents = [
        <Button action={`/${nextFrame}/${channelId}`}>Done</Button>,
      ];
    }
  } else {
    textFrame = `Ok, either confirm ${contractAddresses[currentPage]} on ${network} is the one you want to add, or write it on the input and confirm.`;
    dynamicIntents = [
      <TextInput placeholder="Contract Address..." />,
      prevBtn(currentPage),
      nextBtn(currentPage),
      <Button value='done'>confirm</Button >,
    ];
  }
  console.log("call end: frame-setup-contract/:network/:page");
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
    intents: dynamicIntents
  })
});

app.frame('/frame-purchase/:checkoutId', (c) => {
  const { buttonValue, inputText, status, req } = c;
  const checkoutId = req.param('checkoutId');
  const checkoutUrl = `https://app.unlock-protocol.com/checkout?id=${checkoutId}`;
  console.log("checkoutId: ", checkoutUrl);

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
          }}
        >
          {
            `Checkout by pressing the mint button!`
          }
        </div>
      </div>
    ),
    intents: [
      <Button.Link href={checkoutUrl}>Mint</Button.Link>
    ],
  })
})

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
