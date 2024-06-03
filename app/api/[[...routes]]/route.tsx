/** @jsxImportSource frog/jsx */

import { Button, FrameContext, Frog, TextInput } from 'frog'
import { devtools } from 'frog/dev'
import { neynar } from 'frog/hubs'
import { handle } from 'frog/next'
import { serveStatic } from 'frog/serve-static'
import neynarClient from '@/app/lib/neynarClient'
import { ReactionType } from '@neynar/nodejs-sdk';
import { Address } from 'viem'
import { hasMembership } from '@/app/utils/unlock'

const app = new Frog({
  assetsPath: '/',
  basePath: '/api',
  hub: neynar({ apiKey: process.env.NEYNAR_API_KEY! }),
})

// Uncomment to use Edge Runtime
// export const runtime = 'edge'

app.hono.post("/validate", async (c) => {
  try {
    const body = await c.req.json();

    let fid = body.data.author.fid;
    let username = body.data.author.username;
    let castHash = body.data.hash;
    const userAddresses = await getDistinctAddresses(fid);
    console.log("result: ", body);
    console.log("useAddresses: ", userAddresses);
    // let validMembership = await hasMembership(userAddresses[0]);
    let validMembership = false;

    if (validMembership) {
      let castReactionResponse = await neynarClient.publishReactionToCast(process.env.SIGNER_UUID!, ReactionType.Like, castHash);
      console.log("Cast reaction successful:", castReactionResponse);
      return c.json({ message: "Cast reaction successful!" });
    } else {
      let message = `Hey @${username}, it looks like you don't have a subscription yet. Let me help you with that.`;
      // const castResponse = await neynarClient.publishCast(
      //   process.env.SIGNER_UUID!,
      //   message,
      //   { idem: 'my-cast-idem' }
      // );
      const castResponse = await neynarClient.publishCast(
        process.env.SIGNER_UUID!,
        message,
        {
          embeds: [
            {
              url: 'https://2fd6-47-147-81-136.ngrok-free.app/api/9c3d6b6c-d3d1-424e-a5f0-b2489a68fbed', // Get at https://app.unlock-protocol.com/locks/checkout-url
            }]
        }
      );
      if (!castResponse.hash) {
        return c.json({ message: 'Error casting message.' }, 500);
      }
      const castData = (await castResponse).text;
      console.log("Cast successful:", castData);

      return c.json({ message: "Cast successful!" });
    }
  } catch (e) {
    console.error("Error:", e);
    return c.json({ message: "Error processing request." }, 500);
  }
});

app.frame('/:checkoutId', (c: FrameContext) => {
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