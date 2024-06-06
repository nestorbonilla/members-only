/** @jsxImportSource frog/jsx */

import { Button, FrameContext, Frog, TextInput } from 'frog'
import { devtools } from 'frog/dev'
import { neynar } from 'frog/hubs'
import { handle } from 'frog/next'
import { serveStatic } from 'frog/serve-static'
import neynarClient from '@/app/utils/neynar/client'

import { Cast, Channel, ReactionType } from '@neynar/nodejs-sdk/build/neynar-api/v2'
import { Address } from 'viem'
import { hasMembership } from '@/app/utils/unlock/membership'
import { createClient } from '@/app/utils/supabase/server'

const APP_URL = process.env.APP_URL;
const BOT_SETUP_TEXT = process.env.BOT_SETUP_TEXT; // edit to @membersonly setup

const app = new Frog({
  assetsPath: '/',
  origin: APP_URL,
  basePath: '/api',
  hub: neynar({ apiKey: process.env.NEYNAR_API_KEY! }),
  imageOptions: {
    format: "png",
  },
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
      console.log("frame url: ", `${APP_URL}/api/frame-setup/${channelId}`);
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

app.frame('/frame-setup/:channelId', (c: FrameContext) => {
  console.log("call start: frame-setup");
  const channelId = c.req.param('channelId');
  const { buttonValue, status } = c;
  console.log("call end: frame-setup");
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
      <Button action='/frame-contract/base'>Base</Button>,
      <Button action='/frame-contract/optimism'>Optimism</Button>,
      <Button action='/frame-contract/arbitrum'>Arbitrum</Button>,
      status === 'response' && <Button.Reset>Reset</Button.Reset>,
    ],
  })
});

app.frame('/frame-contract/:chain', (c: FrameContext) => {
  const chain = c.req.param('chain');
  const { buttonValue, inputText, status } = c
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
          Hey ${chain}
        </div>
      </div>
    ),
    intents: [
      <Button action='/frame-contract-confirmation/0x'>Contract</Button>,
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