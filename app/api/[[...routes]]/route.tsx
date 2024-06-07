/** @jsxImportSource frog/jsx */

import { Button, Frog, TextInput } from 'frog';
import { devtools } from 'frog/dev';
import { neynar } from 'frog/hubs';
import { handle } from 'frog/next';
import { serveStatic } from 'frog/serve-static';
import neynarClient from '@/app/utils/neynar/client';
import { Cast, Channel, ChannelType, ReactionType, ValidateFrameActionResponse } from '@neynar/nodejs-sdk/build/neynar-api/v2';
import { Address } from 'viem';
import { hasMembership } from '@/app/utils/unlock/membership';
import { createClient } from '@/app/utils/supabase/server';
const { Network } = require('alchemy-sdk');

const APP_URL = process.env.APP_URL;
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
const BOT_SETUP_TEXT = process.env.BOT_SETUP_TEXT; // edit to @membersonly setup
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const ACCESS_RULES_LIMIT = 3;
const UNLOCK_PROXY = "0xd0b14797b9d08493392865647384974470202a78"; // need to better way if multiple chains or different proxies

const app = new Frog({
  assetsPath: '/',
  basePath: '/api',
  hub: neynar({ apiKey: NEYNAR_API_KEY! }),
  verify: process.env.NODE_ENV === 'production' // leave it as is, if not issue with frog local debug tool
})

// Uncomment to use Edge Runtime
// export const runtime = 'edge'

app.hono.post("/hook-setup", async (c) => {
  try {
    console.log("call start: hook-setup");

    const body = await c.req.json();
    let cast: Cast = body.data;
    console.log("cast: ", cast);

    // 1. Validate the cast author is the owner of the channel
    // 1.1 Get the channel owner
    console.log("call start: hook-setup => fetchBulkChannels");
    let channels: Array<Channel> = (await neynarClient.fetchBulkChannels([cast.parent_url!], { type: ChannelType.ParentUrl })).channels;
    !channels || channels.length == 0 ? c.json({ message: `Channel not found with parent_url ${cast.parent_url}` }, 404) : null;
    let channelId = channels[0].id;
    let channelLead = channels[0].lead?.fid;

    // 1.2 Get the cast author
    let castAuthor = cast.author.fid;

    // 1.3 Compare the channel owner and the cast author and validate the cast text is "@membersonly setup"
    // Probably second validation will be removed and just validated on the hook
    let castText = cast.text;

    console.log("call start: hook-setup => castAuthor == castText");
    if (channelLead == castAuthor && castText == BOT_SETUP_TEXT) {
      console.log("frame url: ", `${APP_URL}/api/frame-setup-channel/${channelId}`);
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
        return c.json({ message: 'Error casting message.' }, 500);
      }

    } else {
      return c.json({ message: "You are not the owner of this channel." }, 403);
    }
  } catch (e) {
    console.error("Error:", e);
    return c.json({ message: "Error processing request." }, 500);
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
      console.log("fid: ", fid);
      const userAddresses = await getDistinctAddresses(fid.toString());
      const supabase = createClient();
      // let validMembership = await hasMembership(userAddresses[0]);
      let validMembership = true;

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

app.frame('/frame-setup-channel/:channelId', async (c) => {
  console.log("call start: frame-setup-channel/:channelId");
  const { req } = c;

  const channelId = req.param('channelId');

  let dynamicIntents = [];
  let nextFrame = "frame-setup-channel-action";
  let prevFrame = "/";
  let conditions = 0;

  // Get the channel access rules
  const supabaseClient = createClient();
  const { data, error } = await supabaseClient
    .from('channel_access_rules')
    .select('*')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(ACCESS_RULES_LIMIT);
  if (data?.length! > 0) {
    conditions = data!.length;
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
          {channelId} channel has {conditions == 0 ? "no" : conditions} rules
        </div>
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
    const supabaseClient = createClient();
    const { data, error } = await supabaseClient
      .from('channel_access_rules')
      .select('*')
      .eq('channel_id', channelId)
      .order('created_at', { ascending: false })
      .limit(ACCESS_RULES_LIMIT);
    if (data?.length! > 0) {
      conditions = data!.length;
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
  let channelId = "unlock";


  // console.log("messageBytes: ", payload.trustedData.messageBytes);
  // // Validate the frame action response
  // const frameActionResponse: ValidateFrameActionResponse = await neynarClient.validateFrameAction(payload.trustedData.messageBytes);
  // console.log("frameActionResponse: ", frameActionResponse);

  // pending to get eth addresses from account
  let ethAddresses = ["0xe8f5533ba4c562b2162e8cf9b769a69cd28e811d"];
  const contractAddresses: string[] = (
    await Promise.all(
      ethAddresses.map(async (ethAddress) =>
        getContractsDeployed(ethAddress, network!)
      )
    )
  ).flat();
  console.log("contractAddresses: ", contractAddresses);

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
    const supabaseClient = createClient();
    const { error: insertError } = await supabaseClient
      .from('channel_access_rules')
      .insert([
        {
          channel_id: channelId,
          operator: "AND",
          rule_behavior: "ALLOW",
          network: network,
          contract_address: inputText
        },
      ]);
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
            `Welcome! ${checkoutUrl}`
          }
        </div>
      </div>
    ),
    intents: [
      <Button.Link href={checkoutUrl}>Mint</Button.Link>
    ],
  })
})

devtools(app, { serveStatic })

export const GET = handle(app)
export const POST = handle(app)


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
  // Pending to verify if I need to validate if parent cast is a setup cast too
  return castText.trim().toLowerCase() === BOT_SETUP_TEXT!.toLowerCase(); // Case-insensitive check
}

function getLastPartOfUrl(url: string) {
  const urlObj = new URL(url);
  const parts = urlObj.pathname.split('/');
  return parts[parts.length - 1];
}

const getContractsDeployed = async (address: string, network: string): Promise<string[]> => {
  let RPC = getRpc(network);
  try {
    const txWithProxy = await fetch(RPC, {
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
            toAddress: UNLOCK_PROXY,
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
        const response = await fetch(RPC, {
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
          throw new Error(`Request for block ${txHash} failed`);
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

function getRpc(networkName: string): string {
  switch (networkName) {
    case "base":
      return `${process.env.ALCHEMY_URL_BASE}${ALCHEMY_API_KEY}`;
    case "optimism":
      return Network.OPTIMISM_MAINNET;
    case "ethereum":
      return Network.ETHEREUM_MAINNET;
    case "arbitrum":
      return Network.ARBITRUM_MAINNET;
    default:
      throw new Error(`Unsupported network: ${networkName}`);
  }
}