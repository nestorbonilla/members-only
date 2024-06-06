/** @jsxImportSource frog/jsx */

import { Button, FrameContext, Frog, TextInput } from 'frog'
import { devtools } from 'frog/dev'
import { neynar } from 'frog/hubs'
import { handle } from 'frog/next'
import { serveStatic } from 'frog/serve-static'
import neynarClient from '@/app/utils/neynar/client'

import { Cast, Channel, ReactionType, ValidateFrameActionResponse } from '@neynar/nodejs-sdk/build/neynar-api/v2'
import { Address } from 'viem'
import { hasMembership } from '@/app/utils/unlock/membership'
import { createClient } from '@/app/utils/supabase/server'

const { Network, Alchemy } = require("alchemy-sdk");

const APP_URL = process.env.APP_URL;
const BOT_SETUP_TEXT = process.env.BOT_SETUP_TEXT; // edit to @membersonly setup

const app = new Frog({
  assetsPath: '/',
  basePath: '/api',
  hub: neynar({ apiKey: process.env.NEYNAR_API_KEY! }),
  // verify: process.env.NODE_ENV === 'production'
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
    let channelId = getLastPartOfUrl(cast.root_parent_url!);
    let channels: Array<Channel> = (await neynarClient.searchChannels(channelId)).channels;
    let channelLead = channels[0].lead?.fid;

    // 1.2 Get the cast author
    let castAuthor = cast.author.fid;

    // 1.3 Compare the channel owner and the cast author and validate the cast text is "@membersonly setup"
    // Probably second validation will be removed and just validated on the hook
    let castText = cast.text;

    if (channelLead == castAuthor && castText == BOT_SETUP_TEXT) {
      console.log("frame url: ", `${APP_URL}/api/frame-channel/${channelId}`);
      const castResponse = await neynarClient.publishCast(
        process.env.SIGNER_UUID!,
        "",
        {
          replyTo: cast.hash,
          embeds: [
            {
              url: `${APP_URL}/api/frame-setup/${channelId}`,
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

app.frame('/frame-channel/:channelId', (c: FrameContext) => {
  console.log("call start: frame-setup/:channelId");
  const channelId = c.req.param('channelId');
  const { buttonValue, status } = c;
  console.log("call end: frame-setup/:channelId");
  return c.res({
    image: (
      <div
        style={{
          alignItems: 'center',
          background:
            status === 'response'
              ? 'linear-gradient(to right, #432889, #17101F)'
              : 'black',
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
          {channelId} frame setup
        </div>
      </div>
    ),
    intents: [
      <Button action='/frame-contract/base/'>Base</Button>,
      <Button action='/frame-contract/optimism'>Optimism</Button>,
      <Button action='/frame-contract/arbitrum'>Arbitrum</Button>,
      status === 'response' && <Button.Reset>Reset</Button.Reset>,
    ],
  })
});

app.frame('/frame-contract/:chain/:page', async (c: FrameContext) => {
  console.log("call start: frame-contract/:chain");
  const payload = await c.req.json();

  // Validate the frame action response
  const frameActionResponse: ValidateFrameActionResponse = await neynarClient.validateFrameAction(payload.trustedData.messageBytes);

  // Get the chain from the URL and create an Alchemy instance for the specified network
  const chain = c.req.param('chain');
  const page = c.req.param('page');
  console.log("chain and page: ", chain, page);
  const alchemy = new Alchemy({
    apiKey: process.env.ALCHEMY_API_KEY, // Think about better approach for multiple chains
    network: chain == "base" ? Network.Base : Network.Optimism,
  });

  // Get a list of deployed contracts for each verified Ethereum address
  let ethAddresses = frameActionResponse.action.interactor.verified_addresses.eth_addresses;
  let allContractAddresses = await Promise.all(ethAddresses.map(async (ethAddress) => {
    console.log("contractAddress: ", ethAddress);
    const contractAddresses = await findContractsDeployed(ethAddress, alchemy);
    return contractAddresses;
  }));
  allContractAddresses = allContractAddresses.flat();
  console.log("allContractAddresses: ", allContractAddresses);

  let prevContract = `/frame-contract/${chain}/:0`;
  let nextContract = `/frame-contract/${chain}/:0`;
  const { buttonValue, inputText, status } = c;
  console.log("call end: frame-contract/:chain");
  return c.res({
    image: (
      <div
        style={{
          alignItems: 'center',
          background:
            status === 'response'
              ? 'linear-gradient(to right, #432889, #17101F)'
              : 'black',
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
          Hey {chain}
        </div>
      </div>
    ),
    intents: [
      <TextInput placeholder="Contract Address..." />,
      <Button action={prevContract}>prev</Button>,
      <Button action={nextContract}>next</Button>,
      <Button.Reset>back</Button.Reset>,
      <Button action='/frame-channel/:channelId'>custom</Button>,
    ],
  })
});

app.frame('/frame-purchase/:checkoutId', (c: FrameContext) => {
  const checkoutId = c.req.param('checkoutId');
  const checkoutUrl = `https://app.unlock-protocol.com/checkout?id=${checkoutId}`;
  console.log("checkoutId: ", checkoutUrl);
  const { buttonValue, inputText, status } = c
  const fruit = inputText || buttonValue
  return c.res({
    image: (
      <div
        style={{
          alignItems: 'center',
          background:
            status === 'response'
              ? 'linear-gradient(to right, #432889, #17101F)'
              : 'black',
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
          {status === 'response'
            ? `Nice choice.${checkoutUrl} ${fruit ? ` ${fruit.toUpperCase()}!!` : ''}`
            : `Welcome! ${checkoutUrl}`}
        </div>
      </div>
    ),
    intents: [
      <TextInput placeholder="Enter custom fruit..." />,
      <Button.Link href={checkoutUrl}>Mint</Button.Link>,
      status === 'response' && <Button.Reset>Reset</Button.Reset>,
    ],
  })
})

const getDistinctAddresses = async (fid: string): Promise<Address[]> => {
  let fetchedUsers: any = await neynarClient.fetchBulkUsers([Number(fid)]);
  const ethAddresses: (string | undefined)[] | undefined = fetchedUsers.users[0]?.verified_addresses?.eth_addresses;
  return Array.from(new Set(
    (ethAddresses || [])
      .filter(address => typeof address === 'string' && address.startsWith('0x'))
      .map(address => address as Address)
  ));
};

devtools(app, { serveStatic })

export const GET = handle(app)
export const POST = handle(app)


//_______________________________________________________________________________________________________________________
// Utils

function isSetupCast(castText: string): boolean {
  // Pending to verify if I need to validate if parent cast is a setup cast too
  return castText.trim().toLowerCase() === BOT_SETUP_TEXT!.toLowerCase(); // Case-insensitive check
}

function getLastPartOfUrl(url: string) {
  const urlObj = new URL(url);
  const parts = urlObj.pathname.split('/');
  return parts[parts.length - 1];
}

// Define the asynchronous function that will retrieve deployed contracts
async function findContractsDeployed(address: string, alchemy: any) {
  const transfers = [];

  // Paginate through the results using getAssetTransfers method
  let response = await alchemy.core.getAssetTransfers({
    fromBlock: "0x0",
    toBlock: "latest", // Fetch results up to the latest block
    fromAddress: address, // Filter results to only include transfers from the specified address
    excludeZeroValue: false, // Include transfers with a value of 0
    category: ["external"], // Filter results to only include external transfers
  });
  transfers.push(...response.transfers);

  // Continue fetching and aggregating results while there are more pages
  while (response.pageKey) {
    let pageKey = response.pageKey;
    response = await alchemy.core.getAssetTransfers({
      fromBlock: "0x0",
      toBlock: "latest",
      fromAddress: address,
      excludeZeroValue: false,
      category: ["external"],
      pageKey: pageKey,
    });
    transfers.push(...response.transfers);
  }

  // Filter the transfers to only include contract deployments (where 'to' is null)
  const deployments = transfers.filter((transfer) => transfer.to === null);
  const txHashes = deployments.map((deployment) => deployment.hash);

  // Fetch the transaction receipts for each of the deployment transactions
  const promises = txHashes.map((hash) =>
    alchemy.core.getTransactionReceipt(hash)
  );

  // Wait for all the transaction receipts to be fetched
  const receipts = await Promise.all(promises);
  const contractAddresses = receipts.map((receipt) => receipt?.contractAddress);
  return contractAddresses;
}