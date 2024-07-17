/** @jsxImportSource frog/jsx */

import { Button, FrameContext, Frog, TextInput } from 'frog';
import { Box, Heading, Text, VStack, Spacer, vars } from '@/app/utils/frog/ui';
import { devtools } from 'frog/dev';
import { neynar, type NeynarVariables } from 'frog/middlewares';
import { handle } from 'frog/next';
import { serveStatic } from 'frog/serve-static';
import neynarClient, { getEipChainId } from '@/app/utils/neynar/client';
import {
  Cast,
  Channel,
  ChannelType,
  ReactionType,
  ValidateFrameActionResponse,
} from '@neynar/nodejs-sdk/build/neynar-api/v2';
import { Address, erc20Abi, formatUnits } from 'viem';
import {
  deleteChannelRule,
  doesRuleWithContractExist,
  getChannelRules,
  insertChannelRule,
} from '@/app/utils/supabase/server';
import { getContractsDeployed } from '@/app/utils/alchemy/constants';
import {
  doAddressesHaveValidMembershipInRules,
  getErc20Allowance,
  getErc20Decimals,
  getErc20Symbol,
  getFirstTokenIdOfOwner,
  getLockName,
  getLockPrice,
  getLockTokenAddress,
  getLockTotalKeys,
  getMembersOnlyReferralFee,
  getTokenExpiration,
} from '@/app/utils/viem/constants';
import { contracts } from '@unlock-protocol/contracts';
import { Context } from 'hono';

const app = new Frog({
  title: 'Members Only',
  assetsPath: '/',
  basePath: '/api',
  ui: { vars },
  origin: process.env.APP_URL,
  imageOptions: {
    format: 'png',
  },
  verify: process.env.NODE_ENV === 'production', // leave it as is, if not issue with frog local debug tool
});

const neynarMiddleware = neynar({
  apiKey: process.env.NEYNAR_API_KEY!,
  features: ['interactor', 'cast'],
});

// Uncomment to use Edge Runtime
// export const runtime = 'edge'

enum ApiRoute {
  HOOK_SETUP = 'HOOK-SETUP',
  HOOK_VALIDATE = 'HOOK-VALIDATE',
  FRAME_PURCHASE = 'FRAME-PURCHASE/:CHANNELID',
  FRAME_SETUP = 'FRAME-SETUP/:CHANNELID',
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
  FRAME_MEMBERSHIP_VALID,
  FRAME_MEMBERSHIP_INVALID,
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
    [FramePurchaseResult.FRAME_MEMBERSHIP_VALID]: `${ApiRoute.FRAME_PURCHASE} => UNLOCK MEMBERSHIP IS VALID`,
    [FramePurchaseResult.FRAME_MEMBERSHIP_INVALID]: `${ApiRoute.FRAME_PURCHASE} => UNLOCK MEMBERSHIP IS INVALID`,
  },
};

app.hono.post('/hook-setup', async (c: Context) => {
  try {
    console.log('call start: hook-setup');
    const { status, req } = c;

    const body = await req.json();
    let cast: Cast = body.data;

    // 1. Validate the cast author is the owner of the channel
    // 1.1 Get the channel owner
    let channel = await getChannel(cast.root_parent_url!);
    let channelId = channel?.id;
    let channelLead = channel?.lead?.fid;

    // 1.2 Get the cast author
    let castAuthor = cast.author.fid;

    // 1.3 Compare the channel owner and the cast author and validate the cast text is "@membersonly setup"
    let castText = cast.text;

    if (channelLead == castAuthor) {
      if (castText == process.env.BOT_SETUP_TEXT) {
        const castResponse = await neynarClient.publishCast(
          process.env.SIGNER_UUID!,
          '',
          {
            replyTo: cast.hash,
            embeds: [
              {
                url: `${process.env.APP_URL}/api/frame-setup/${channelId}`,
              },
            ],
          }
        );
        if (castResponse.hash) {
          // Now let's update the validate hook
          const webhooks = await neynarClient
            .fetchWebhooks()
            .then((res) => res.webhooks);
          const targetWebhook = webhooks.find(
            (webhook) => webhook.title === process.env.MO_HOOK_VALIDATE_TITLE
          );
          if (
            !targetWebhook ||
            !targetWebhook.subscription ||
            !targetWebhook.subscription.filters['cast.created']
          ) {
            throw new Error(
              `Webhook with title "${process.env.MO_HOOK_VALIDATE_TITLE}" or its filters not found.`
            );
          } else {
            const castCreatedFilter =
              targetWebhook.subscription.filters['cast.created'];
            let rootParentUrls = castCreatedFilter.root_parent_urls || [];
            // Ensure channel is defined
            if (channel && channel.url && channel.parent_url) {
              const textFound = rootParentUrls.some((url: string) =>
                url.includes(channel.url)
              );
              if (!textFound) {
                const updatedRootParentUrls = [
                  ...new Set([...rootParentUrls, channel.parent_url]),
                ]; // Remove duplicates
                const updateWebhook = await neynarClient.updateWebhook(
                  process.env.MO_HOOK_VALIDATE_ID!,
                  process.env.MO_HOOK_VALIDATE_TITLE!,
                  process.env.MO_HOOK_VALIDATE_TARGET_URL!,
                  {
                    subscription: {
                      'cast.created': {
                        root_parent_urls: updatedRootParentUrls,
                      },
                    },
                  }
                );
                updateWebhook.success
                  ? console.log('Validate webhook updated successfully')
                  : console.log('Failed to update validate webhook');
              }
            } else {
              console.error('Channel information is missing or incomplete');
            }
          }

          return c.json({
            message:
              statusMessage[ApiRoute.HOOK_SETUP][HookSetupResult.CAST_SUCCESS],
          });
        } else {
          return c.json({
            message:
              statusMessage[ApiRoute.HOOK_SETUP][HookSetupResult.CAST_ERROR],
          });
        }
      } else {
        return c.json({
          message:
            statusMessage[ApiRoute.HOOK_SETUP][
              HookSetupResult.UNEXPECTED_ERROR
            ],
        });
      }
    } else {
      return c.json({
        message:
          statusMessage[ApiRoute.HOOK_SETUP][HookSetupResult.INVALID_AUTHOR],
      });
    }
  } catch (e) {
    return c.json({
      message: statusMessage[ApiRoute.HOOK_SETUP][HookSetupResult.ROUTE_ERROR],
    });
  }
});

app.hono.post('/hook-validate', async (c) => {
  try {
    console.log('call start: hook-validate');

    const body = await c.req.json();
    let cast: Cast = body.data;

    if (isSetupCast(cast.text)) {
      return c.json({
        message:
          statusMessage[ApiRoute.HOOK_VALIDATE][HookValidateResult.SETUP_TEXT],
      });
    } else {
      let username = body.data.author.username;
      let castHash = body.data.hash;
      let channel = await getChannel(cast.root_parent_url!);
      let channelRules = await getChannelRules(channel?.id!);
      const userAddresses = cast.author.verified_addresses.eth_addresses;
      let membershipIsValidForAtLeastOneAddress =
        await doAddressesHaveValidMembershipInRules(
          userAddresses,
          channelRules
        );
      if (membershipIsValidForAtLeastOneAddress) {
        let castReactionResponse = await neynarClient.publishReactionToCast(
          process.env.SIGNER_UUID!,
          ReactionType.Like,
          castHash
        );
        if (castReactionResponse.success) {
          return c.json({
            message:
              statusMessage[ApiRoute.HOOK_VALIDATE][
                HookValidateResult.CAST_REACTION_SUCCESS
              ],
          });
        } else {
          return c.json({
            message:
              statusMessage[ApiRoute.HOOK_VALIDATE][
                HookValidateResult.CAST_REACTION_ERROR
              ],
          });
        }
      } else {
        let textCast = '';
        // Determine if the user has no key or if the user has a key but it's expired
        let totalKeysCount = await getLockTotalKeys(
          userAddresses[0],
          channelRules[0].contract_address,
          channelRules[0].network
        );
        if (totalKeysCount == 0) {
          // if no keys then no nft, so suggest cast owner to buy a new key of the lock
          textCast = `Hey @${username}, it looks like you don't have a key to access ${channel?.id} channel yet. Let me help you with that.`;
        } else {
          // One or more keys are expired, so let's renew the first we found
          textCast = `Hey @${username}, it looks like you have an expired key to access ${channel?.id} channel. Let me help you with that.`;
        }
        const castResponse = await neynarClient.publishCast(
          process.env.SIGNER_UUID!,
          textCast,
          {
            embeds: [
              {
                url: `${process.env.APP_URL}/api/frame-purchase/${channel?.id}`, // Get at https://app.unlock-protocol.com/locks/checkout-url
              },
            ],
          }
        );
        console.log('call end: hook-validate');
        if (castResponse.hash) {
          return c.json({
            message:
              statusMessage[ApiRoute.HOOK_VALIDATE][
                HookValidateResult.CAST_FRAME_SUCCESS
              ],
          });
        } else {
          return c.json({
            message:
              statusMessage[ApiRoute.HOOK_VALIDATE][
                HookValidateResult.CAST_FRAME_ERROR
              ],
          });
        }
      }
    }
  } catch (e) {
    return c.json({
      message:
        statusMessage[ApiRoute.HOOK_VALIDATE][HookValidateResult.ROUTE_ERROR],
    });
  }
});

app.frame(
  '/frame-purchase/:channelId',
  neynarMiddleware,
  async (c: FrameContext) => {
    const { buttonValue, status, req } = c;
    let ethAddresses: string[] = [];
    let channelId = req.param('channelId');
    let textFrame = '';
    let dynamicIntents: any[] = [];
    let totalKeysCount = 0;
    let erc20Allowance = BigInt(0);
    let lockTokenSymbol = '';
    let lockTokenDecimals = 18; // most ERC20 tokens have 18 decimals
    let lockTokenPriceVisual = '';

    // Get the channel access rules
    let channelRules = await getChannelRules(channelId!);
    textFrame = `This channel requires membership(s). To purchase or renew one, let's verify some details.`;
    if (
      status == 'initial' ||
      (status == 'response' && buttonValue == 'done')
    ) {
      // Step 1: Show the number of rules on the channel
      dynamicIntents = [<Button value="verify">go</Button>];
    } else if (status == 'response') {
      const payload = await req.json();
      if (process.env.NODE_ENV === 'production') {
        const frameActionResponse: ValidateFrameActionResponse =
          await neynarClient.validateFrameAction(
            payload.trustedData.messageBytes
          );
        if (frameActionResponse.valid) {
          ethAddresses =
            frameActionResponse.action.interactor.verified_addresses
              .eth_addresses;
          console.log(
            statusMessage[ApiRoute.FRAME_PURCHASE][
              FramePurchaseResult.FRAME_ACTION_VALID
            ]
          );
        } else {
          console.log(
            statusMessage[ApiRoute.FRAME_PURCHASE][
              FramePurchaseResult.FRAME_ACTION_INVALID
            ]
          );
        }
      } else {
        // For local development only
        ethAddresses = [process.env.APP_TEST_ADDRESS!];
      }
      if (ethAddresses.length > 0) {
        const prevBtn = (index: number) => {
          if (channelRules.length > 0 && index > 0) {
            return <Button value={`page-${index - 1}`}>prev</Button>;
          }
        };
        const nextBtn = (index: number) => {
          if (channelRules.length > index + 1) {
            return <Button value={`page-${index + 1}`}>next</Button>;
          }
        };
        if (buttonValue == 'verify' || buttonValue?.startsWith('page-')) {
          let tokenId: number | null = null;
          let userAddress: string | null = null;

          if (channelRules.length > 0) {
            let currentRule: any;
            let currentPage = 0;
            if (buttonValue == 'verify') {
              currentRule = channelRules[0];
            } else if (buttonValue?.startsWith('page-')) {
              let [_, page] = buttonValue!.split('-');
              currentPage = parseInt(page);
              currentRule = channelRules[currentPage];
            }
            // Verify the user doesn't have a valid membership the first rule
            let lockName = await getLockName(
              currentRule.contract_address,
              currentRule.network
            );
            let lockPrice = await getLockPrice(
              currentRule.contract_address,
              currentRule.network
            );
            let membershipIsValidForAtLeastOneAddress =
              await doAddressesHaveValidMembershipInRules(ethAddresses, [
                currentRule,
              ]);
            let keyCounts = await Promise.all(
              ethAddresses.map((ethAddress) =>
                getLockTotalKeys(
                  ethAddress,
                  currentRule.contract_address,
                  currentRule.network
                )
              )
            );
            let totalKeysCount = keyCounts.reduce(
              (sum, count) => sum + Number(count),
              0
            );
            let tokenInfo = await getFirstTokenIdOfOwner(
              ethAddresses,
              totalKeysCount,
              currentRule.contract_address,
              currentRule.network
            );
            let lockTokenAddress = await getLockTokenAddress(
              currentRule.contract_address,
              currentRule.network
            );
            if (lockTokenAddress == process.env.ZERO_ADDRESS) {
              // if the token address is zero address, then it's ether
              lockTokenSymbol = 'ETH';
              erc20Allowance = lockPrice; // txs with ETH don't need approval
            } else {
              lockTokenSymbol = await getErc20Symbol(
                lockTokenAddress,
                currentRule.network
              );
              lockTokenDecimals = await getErc20Decimals(
                lockTokenAddress,
                currentRule.network
              );
              erc20Allowance = await getErc20Allowance(
                ethAddresses[0],
                lockTokenAddress,
                currentRule.contract_address,
                currentRule.network
              );
            }
            lockTokenPriceVisual = formatUnits(lockPrice, lockTokenDecimals);
            // is membership renewable or allowed to buy a new one?
            // if yes, then show the 'increase allowance' button
            if (membershipIsValidForAtLeastOneAddress && tokenInfo) {
              console.log(
                statusMessage[ApiRoute.FRAME_PURCHASE][
                  FramePurchaseResult.FRAME_MEMBERSHIP_VALID
                ]
              );
              ({ tokenId, userAddress } = tokenInfo);
              // if membership is valid, then if it's renewable
              let keyExpirationInSeconds = await getTokenExpiration(
                tokenId,
                currentRule.contract_address,
                currentRule.network
              );
              const currentTimeMs = Date.now();
              const keyExpirationMiliseconds =
                Number(keyExpirationInSeconds) * 1000;
              const remainingTimeDays =
                (keyExpirationMiliseconds - currentTimeMs) /
                (1000 * 60 * 60 * 24); // Days remaining
              const showExpirationTime = remainingTimeDays <= 30; // Threshold of 30 days
              const options: Intl.DateTimeFormatOptions = {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
                second: 'numeric',
                timeZoneName: 'short', // Optional: Show timezone
              };
              let keyExpirationDate = new Date(keyExpirationMiliseconds);
              let keyExpirationString = keyExpirationDate.toLocaleString(
                undefined,
                options
              );
              textFrame = showExpirationTime
                ? ` You own a valid membership for "${lockName}", deployed on ${currentRule.network} network, and is valid til ${keyExpirationString}`
                : ` You own a valid membership for "${lockName}", deployed on ${currentRule.network} network.`;
              dynamicIntents = [
                <Button value="done">complete</Button>,
                prevBtn(currentPage),
                nextBtn(currentPage),
              ];
            } else {
              console.log(
                statusMessage[ApiRoute.FRAME_PURCHASE][
                  FramePurchaseResult.FRAME_MEMBERSHIP_INVALID
                ]
              );
              textFrame = ` You don't own a valid membership for the lock "${lockName}", deployed on ${currentRule.network} network. It costs ${lockTokenPriceVisual} ${lockTokenSymbol} to purchase a key.`;
              const allowBtn = () => {
                if (erc20Allowance < lockPrice) {
                  return (
                    <Button value={`approval-${0}`}>increase allowance</Button>
                  );
                }
              };

              const buyBtn = () => {
                if (
                  erc20Allowance >= lockPrice &&
                  totalKeysCount == 0 &&
                  (!tokenInfo || tokenInfo.tokenId === 0) // Check if tokenInfo is null OR tokenId is 0
                ) {
                  return (
                    <Button.Transaction
                      target={`/tx-purchase/${currentRule.network}/${currentRule.contract_address}/${lockTokenSymbol}/${ethAddresses[0]}`}
                    >
                      buy
                    </Button.Transaction>
                  );
                }
              };

              const renewBtn = async () => {
                if (
                  erc20Allowance >= lockPrice &&
                  totalKeysCount > 0 &&
                  tokenInfo?.tokenId &&
                  tokenInfo.tokenId > 0 // Explicit check for tokenId > 0
                ) {
                  const tokenIdForRenewal = tokenInfo?.tokenId;
                  // Before renewing the key, let's verify if it is renewable
                  let isRenewable = !tokenInfo?.isValid;
                  if (isRenewable) {
                    // One or more keys are expired, so let's renew the first we found
                    return (
                      <Button.Transaction
                        target={`/tx-renew/${currentRule.network}/${currentRule.contract_address}/${tokenIdForRenewal}/${lockPrice}`}
                      >
                        renew
                      </Button.Transaction>
                    );
                  }
                }
              };

              dynamicIntents = [
                prevBtn(currentPage),
                nextBtn(currentPage),
                allowBtn(),
                buyBtn(),
                await renewBtn(),
              ];
            }
          } else {
            textFrame = `It seems there are no rules currently to purchase for this channel.`;
            dynamicIntents = [<Button value="verify">complete</Button>];
          }
        } else if (buttonValue?.startsWith('approval-')) {
          textFrame = `Do you want to approve one time (default), or multiple times? (set a number higher than 1)`;
          let [_, page] = buttonValue!.split('-');
          let currentPage = parseInt(page);
          let currentRule = channelRules[currentPage];
          let lockTokenAddress = await getLockTokenAddress(
            currentRule.contract_address,
            currentRule.network
          );
          let lockPrice = await getLockPrice(
            currentRule.contract_address,
            currentRule.network
          );
          dynamicIntents = [
            <TextInput placeholder="amount..." />,
            <Button.Transaction
              target={`/tx-approval/${currentRule.network}/${currentRule.contract_address}/${lockTokenAddress}/${lockPrice}`}
            >
              approve
            </Button.Transaction>,
          ];
        } else if (buttonValue == '_t') {
          textFrame = `Transaction sent! It's on its way to the blockchain. Just a short wait, then click "continue."`;
          dynamicIntents = [<Button value="done">continue</Button>];
        }
      } else {
        textFrame = `No verified Ethereum address found. Please verify at least one address to continue.`;
      }
    }
    return c.res({
      title: 'Members Only - Membership Purchase',
      image: (
        <Box
          grow
          alignHorizontal="center"
          backgroundColor="background"
          padding="32"
          borderStyle="solid"
          borderRadius="8"
          borderWidth="4"
          borderColor="yellow"
        >
          <VStack gap="4">
            <Heading color={'black'}>@membersonly user</Heading>
            <Spacer size="20" />
            <Text color={'black'} size="20">
              Channel: {channelId}
            </Text>
            <Spacer size="10" />
            <Text color={'black'} size="18">
              {textFrame}
            </Text>
          </VStack>
        </Box>
      ),
      intents: dynamicIntents,
    });
  }
);

app.frame('/frame-setup/:channelId', neynarMiddleware, async (c) => {
  console.log('call start: frame-setup/:channelId');
  const { buttonValue, inputText, status, req } = c;
  let ethAddresses: string[] = [];
  let interactorIsChannelLead = false;
  let channelId = req.param('channelId');
  let textFrame = '';
  let dynamicIntents: any[] = [];
  let conditions = 0;

  // Get the channel access rules
  let channelRules: {
    id: Number;
    channel_id: string;
    network: string;
    contract_address: string;
  }[] = await getChannelRules(channelId!);
  conditions = channelRules?.length ?? 0;

  if (status == 'response') {
    // Validate the frame action response and obtain ethAddresses and channelId
    const payload = await req.json();
    if (process.env.NODE_ENV === 'production') {
      const frameActionResponse: ValidateFrameActionResponse =
        await neynarClient.validateFrameAction(
          payload.trustedData.messageBytes
        );
      if (frameActionResponse.valid) {
        ethAddresses =
          frameActionResponse.action.interactor.verified_addresses
            .eth_addresses;
        let channel = await getChannel(
          frameActionResponse.action.cast.root_parent_url!
        );
        let interactor = frameActionResponse.action.interactor?.fid;
        let channelLead = channel?.lead?.fid;
        if (channelLead == interactor) {
          interactorIsChannelLead = true;
        }
        console.log(
          statusMessage[ApiRoute.FRAME_SETUP][
            FrameSetupResult.FRAME_ACTION_VALID
          ]
        );
      } else {
        console.log(
          statusMessage[ApiRoute.FRAME_SETUP][
            FrameSetupResult.FRAME_ACTION_INVALID
          ]
        );
      }
    } else {
      // For local development
      ethAddresses = [process.env.APP_TEST_ADDRESS!];
      interactorIsChannelLead = true;
    }
  }

  if (status == 'initial' || (status == 'response' && buttonValue == 'done')) {
    // Step 1: Show general information about the frame
    textFrame = `Let's set up membersonly to manage your channel memberships.`;
    dynamicIntents = [<Button value="go">go</Button>];
  } else if (status == 'response') {
    if (interactorIsChannelLead) {
      // Step 2: Show action to do, either add or remove a rule
      if (buttonValue == 'go') {
        let lockName;
        if (channelRules?.length! > 0) {
          lockName = await getLockName(
            channelRules![0].contract_address,
            channelRules![0].network
          );
        }
        if (channelRules?.length! == 0) {
          textFrame = `You currently have no membership requirements for this channel. Let's add one.`;
          dynamicIntents = [<Button value="add">add</Button>];
        } else {
          if (conditions >= Number(process.env.ACCESS_RULES_LIMIT)) {
            textFrame = `You currently have ${channelRules?.length!} membership requirement${channelRules?.length! > 1 ? 's' : ''} for this channel.\n ${lockName} (${shortenAddress(channelRules![0].contract_address)}) deployed on ${channelRules![0].network} network.`;
            dynamicIntents = [<Button value="remove">remove</Button>];
          } else {
            textFrame = `You currently have ${channelRules?.length!} membership requirement${channelRules?.length! > 1 ? 's' : ''} for this channel.`;
            dynamicIntents = [
              <Button value="add">add</Button>,
              <Button value="remove">remove</Button>,
            ];
          }
        }
      } else if (buttonValue == 'add' || buttonValue == 'remove') {
        if (buttonValue == 'add') {
          textFrame = `Please select the network where your membership contract is deployed.`;
          dynamicIntents = [
            <Button value="base">base</Button>,
            <Button value="optimism">optimism</Button>,
            <Button value="arbitrum">arbitrum</Button>,
          ];
        } else if (buttonValue == 'remove') {
          const nextBtn = (index: number) => {
            if (channelRules.length > 1 && index) {
              return <Button value={`removepage-${index}`}>next</Button>;
            }
          };
          if (channelRules?.length! == 0) {
            textFrame = `There are no membership requirements to remove.`;
            dynamicIntents = [<Button value="done">back</Button>];
          } else {
            let currentRule = channelRules[0];
            let firstContractAddress = currentRule.contract_address;
            let lockName = await getLockName(
              currentRule.contract_address,
              currentRule.network
            );
            textFrame = `Do you want to remove the membership requirement for "${lockName}" (${shortenAddress(currentRule.contract_address)}) on ${currentRule.network} network?`;
            dynamicIntents = [
              nextBtn(1),
              <Button value={`removeconfirm-${firstContractAddress}`}>
                yes
              </Button>,
              <Button value={`done`}>no</Button>,
            ];
          }
        }
        console.log('add or remove selection: end');
      } else if (
        buttonValue == 'base' ||
        buttonValue == 'optimism' ||
        buttonValue == 'arbitrum'
      ) {
        console.log('network selection: start');
        // Step 3: Show the contract addresses deployed on the selected network
        let network = buttonValue;
        const contractAddresses: string[] = (
          await Promise.all(
            ethAddresses.map(async (ethAddress) =>
              getContractsDeployed(ethAddress, network)
            )
          )
        ).flat();

        if (!contractAddresses || contractAddresses.length === 0) {
          textFrame = `No membership contracts found under your management on ${buttonValue} network. To set up a requirement, you can use a custom address (Unlock Membership).`;
          dynamicIntents = [
            <TextInput placeholder="contract address..." />,
            <Button value={`addconfirm-${network}-${process.env.ZERO_ADDRESS}`}>
              custom
            </Button>,
          ];
        } else {
          const nextBtn = (index: number) => {
            if (
              contractAddresses.length > 1 &&
              index < contractAddresses.length - 1
            ) {
              return (
                <Button value={`addpage-${network}-${index + 1}`}>next</Button>
              );
            }
          };
          let lockName = await getLockName(contractAddresses[0], network);
          let currentLock = 1;
          let totalLocks = contractAddresses.length;
          textFrame = `Found ${currentLock} of ${totalLocks} membership contract${totalLocks > 1 ? 's' : ''}: "${lockName}" (${shortenAddress(contractAddresses[0])}). Use this or enter a custom address.`;
          dynamicIntents = [
            nextBtn(0),
            <Button value={`addconfirm-${network}-${contractAddresses[0]}`}>
              use
            </Button>,
            <Button value={`custom-${network}`}>custom</Button>,
          ];
        }
        console.log('network selection: end');
      } else if (buttonValue!.startsWith('custom-')) {
        let [_, network] = buttonValue!.split('-');
        textFrame = `Add your custom address.`;
        dynamicIntents = [
          <TextInput placeholder="contract address..." />,
          <Button value={`addconfirm-${network}-${process.env.ZERO_ADDRESS}`}>
            use
          </Button>,
        ];
      } else if (buttonValue!.startsWith('addpage-')) {
        console.log('addpage-: start');
        // Step 4: Show the contract address to confirm or write a new one
        let [_, network, page] = buttonValue!.split('-');
        let currentPage = parseInt(page);
        const contractAddresses: string[] = (
          await Promise.all(
            ethAddresses.map(async (ethAddress) =>
              getContractsDeployed(ethAddress, network)
            )
          )
        ).flat();

        const prevBtn = (index: number) => {
          if (contractAddresses.length > 0 && index > 0) {
            return (
              <Button value={`addpage-${network}-${index - 1}`}>prev</Button>
            );
          }
        };
        const nextBtn = (index: number) => {
          if (contractAddresses.length > index + 1) {
            return (
              <Button value={`addpage-${network}-${index + 1}`}>next</Button>
            );
          }
        };

        let lockName = await getLockName(
          contractAddresses[currentPage],
          network
        );
        let currentLock = currentPage + 1;
        let totalLocks = contractAddresses.length;
        // here i need to add an extra step, if not I'm asking for the referral fee automatically
        textFrame = `Found ${currentLock} of ${totalLocks} membership contract${totalLocks > 1 ? 's' : ''}: "${lockName}" (${shortenAddress(contractAddresses[currentPage])}). Use this or enter a custom address.`;
        dynamicIntents = [
          prevBtn(currentPage),
          nextBtn(currentPage),
          <Button
            value={`addconfirm-${network}-${contractAddresses[currentPage]}`}
          >
            use
          </Button>,
          <Button value={`addconfirm-${network}-${process.env.ZERO_ADDRESS}`}>
            custom
          </Button>,
        ];
      } else if (buttonValue!.startsWith('addconfirm-')) {
        console.log('addconfirm-: start');
        let [_, network, contractAddress] = buttonValue!.split('-');
        if (contractAddress == process.env.ZERO_ADDRESS) {
          // if it's zero address, then take the address from the input
          contractAddress = inputText!;
        }

        // validate referrer fee
        let referralFee = await getMembersOnlyReferralFee(
          contractAddress,
          network
        );
        if (referralFee !== null) {
          const minReferralFee = BigInt(process.env.MO_MINIMUM_REFERRAL_FEE!);
          let lockName = await getLockName(contractAddress, network);
          if (referralFee < minReferralFee) {
            textFrame = `To add "${lockName}" (${shortenAddress(contractAddress)}) on ${network} network as a membership requirement, please set a 5% referrer fee to @membersonly.`;
            dynamicIntents = [
              <Button value={'done'}>back</Button>,
              <Button.Transaction
                target={`/tx-referrer-fee/${network}/${contractAddress}`}
              >
                set referrer fee
              </Button.Transaction>,
            ];
          } else {
            // Validate there is no rule with the same contract address for this channel
            let ruleExists = await doesRuleWithContractExist(
              channelId,
              contractAddress
            );
            if (ruleExists) {
              textFrame = `The membership requirement for "${lockName}" (${shortenAddress(contractAddress)}) on ${network} network is already set for this channel.`;
              dynamicIntents = [<Button value={'done'}>back</Button>];
            } else {
              let insertError = await insertChannelRule(
                channelId,
                network,
                contractAddress,
                'AND',
                'ALLOW'
              );
              if (insertError) {
                textFrame = `We encountered an issue while adding the membership requirement. Please try again or contact @membersonly for support.`;
                dynamicIntents = [
                  <TextInput placeholder="contract address..." />,
                  <Button value={'done'}>back</Button>,
                  <Button
                    value={`addconfirm-${network}-${process.env.ZERO_ADDRESS}`}
                  >
                    try again
                  </Button>,
                ];
              } else {
                textFrame = `Membership requirement added.`;
                dynamicIntents = [<Button value={'done'}>complete</Button>];
              }
            }
          }
        } else {
          textFrame = `No membership contract found at "${contractAddress}" on ${network} network. Please try again.`;
          dynamicIntents = [<Button value={'done'}>back</Button>];
        }
        console.log('addconfirm-: end');
      } else if (buttonValue!.startsWith('removepage-')) {
        console.log('removepage-: start');
        // Step 4: Show the contract address to confirm or write a new one
        let [_, page] = buttonValue!.split('-');
        let currentPage = parseInt(page);
        let currentRule = channelRules![currentPage];
        let lockName = await getLockName(
          currentRule.contract_address,
          currentRule.network
        );
        textFrame = `Remove "${lockName}" (${shortenAddress(currentRule.contract_address)}) on ${currentRule.network} network as a membership requirement?`;
        const prevBtn = (index: number) => {
          if (channelRules.length > 0 && index > 0) {
            return <Button value={`removepage-${index - 1}`}>prev</Button>;
          }
        };
        const nextBtn = (index: number) => {
          if (channelRules.length > index + 1) {
            return <Button value={`removepage-${index + 1}`}>next</Button>;
          }
        };
        dynamicIntents = [
          prevBtn(currentPage),
          nextBtn(currentPage),
          <Button value={`removeconfirm-${currentRule.contract_address}`}>
            yes
          </Button>,
        ];
        console.log('removepage-: end');
      } else if (buttonValue!.startsWith('removeconfirm-')) {
        console.log('removeconfirm-: start');
        let [_, contractAddress] = buttonValue!.split('-');
        let deleteError = await deleteChannelRule(channelId, contractAddress);
        if (deleteError) {
          textFrame = `We encountered an issue while removing the membership requirement. Please try again or contact @membersonly for support.`;
          dynamicIntents = [
            <Button value={'done'}>Restart</Button>,
            <Button value={`removeconfirm-${contractAddress}`}>
              try again
            </Button>,
          ];
        } else {
          textFrame = `Membership requirement removed.`;
          dynamicIntents = [<Button value={'done'}>complete</Button>];
        }
        console.log('removeconfirm-: end');
      } else if (buttonValue == '_t') {
        textFrame = `Transaction sent! It's on its way to the blockchain. Just a short wait, then click "continue."`;
        dynamicIntents = [<Button value="done">continue</Button>];
      }
    } else {
      textFrame = `It looks like you're not the lead of this channel. If you are, please ensure you're using the correct account.`;
      dynamicIntents = [];
    }
  }
  console.log('call end: frame-setup-channel/:channelId');
  return c.res({
    title: 'Members Only - Channel Setup',
    image: (
      <Box
        grow
        alignHorizontal="center"
        backgroundColor="background"
        padding="32"
        borderStyle="solid"
        borderRadius="8"
        borderWidth="4"
        borderColor="yellow"
      >
        <VStack gap="4">
          <Heading color={'black'}>@membersonly moderator</Heading>
          <Spacer size="20" />
          <Text color={'black'} size="20">
            Channel: {channelId}
          </Text>
          <Spacer size="10" />
          <Text color={'black'} size="18">
            {textFrame}
          </Text>
        </VStack>
      </Box>
    ),
    intents: dynamicIntents,
  });
});

app.transaction('/tx-referrer-fee/:network/:lockAddress', (c) => {
  console.log('call start: tx-referrer-fee/:network/:lockAddress');
  const { inputText, req } = c;
  let lockAddress = req.param('lockAddress');
  let network = req.param('network');
  let customReferrerFee = parseInt(inputText!) * 100;
  let feeBasisPoint;
  if (customReferrerFee > parseInt(process.env.MO_MINIMUM_REFERRAL_FEE!)) {
    feeBasisPoint = BigInt(customReferrerFee);
  } else {
    feeBasisPoint = BigInt(process.env.MO_MINIMUM_REFERRAL_FEE!);
  }
  return c.contract({
    abi: contracts.PublicLockV14.abi,
    chainId: getEipChainId(network),
    functionName: 'setReferrerFee',
    args: [process.env.MO_ADDRESS, feeBasisPoint],
    to: lockAddress as `0x${string}`,
  });
});

app.transaction(
  '/tx-approval/:network/:lockAddress/:lockTokenAddress/:lockPrice',
  async (c) => {
    const { inputText, req } = c;
    let network = req.param('network');
    let lockAddress = req.param('lockAddress');
    let lockTokenAddress = req.param('lockTokenAddress');
    let lockPrice = req.param('lockPrice');
    let paramLockTokenAddress = lockTokenAddress as `0x${string}`;
    let paramLockAddress = lockAddress as `0x${string}`;
    type EipChainId = 'eip155:8453' | 'eip155:10' | 'eip155:42161';
    let paramChainId: EipChainId = getEipChainId(network);
    let customTimes = parseInt(inputText!);
    let price =
      customTimes > 1
        ? BigInt(customTimes) * BigInt(lockPrice)
        : BigInt(lockPrice);

    return c.contract({
      abi: erc20Abi,
      chainId: paramChainId,
      functionName: 'approve',
      args: [
        paramLockAddress, // spender address
        price, // amount uint256
      ],
      to: paramLockTokenAddress,
    });
  }
);

app.transaction(
  '/tx-purchase/:network/:lockAddress/:lockTokenSymbol/:userAddress',
  async (c) => {
    const { req } = c;
    let network = req.param('network');
    let lockAddress = req.param('lockAddress');
    let lockTokenSymbol = req.param('lockTokenSymbol');
    let userAddress = req.param('userAddress');
    let lockPrice = await getLockPrice(lockAddress, network);

    let paramLockAddress = lockAddress as `0x${string}`;
    let paramUserAddress = userAddress as `0x${string}`;
    let paramMOAddress = process.env.MO_ADDRESS as `0x${string}`;
    let paramLockPrice = BigInt(lockPrice);
    type EipChainId = 'eip155:8453' | 'eip155:10' | 'eip155:42161';
    let paramChainId: EipChainId = getEipChainId(network);
    console.log(
      `About to buy/renew a key for lock ${paramLockAddress} on ${paramChainId} network for ${lockPrice} ${lockTokenSymbol} from address ${userAddress}.`
    );

    if (lockTokenSymbol == 'ETH') {
      return c.contract({
        abi: contracts.PublicLockV14.abi,
        chainId: paramChainId,
        functionName: 'purchase',
        args: [
          [paramLockPrice], // _values uint256[]
          [paramUserAddress], // _recipients address[]
          [paramMOAddress], // _referrers address[]
          [paramUserAddress], // _keyManagers address[]
          [''], // _data bytes[]
        ],
        to: paramLockAddress,
        value: paramLockPrice,
      });
    } else {
      return c.contract({
        abi: contracts.PublicLockV14.abi,
        chainId: paramChainId,
        functionName: 'purchase',
        args: [
          [paramLockPrice], // _values uint256[]
          [paramUserAddress], // _recipients address[]
          [paramMOAddress], // _referrers address[]
          [paramUserAddress], // _keyManagers address[]
          [''], // _data bytes[]
        ],
        to: paramLockAddress,
      });
    }
  }
);

app.transaction('/tx-renew/:network/:lockAddress/:tokenId/:price', (c) => {
  const { req } = c;
  let network = req.param('network');
  let lockAddress = req.param('lockAddress');
  let tokenId = req.param('tokenId');
  let price = req.param('price');

  let paramLockAddress = lockAddress as `0x${string}`;
  let paramMOAddress = process.env.MO_ADDRESS as `0x${string}`;
  type EipChainId = 'eip155:8453' | 'eip155:10' | 'eip155:42161';
  let paramChainId: EipChainId = getEipChainId(network);
  let paramLockAbi = contracts.PublicLockV14.abi;
  let paramPrice = BigInt(price);

  return c.contract({
    abi: paramLockAbi,
    chainId: paramChainId,
    functionName: 'extend',
    args: [
      paramPrice, // _values uint256
      tokenId, // _tokenId uint256
      paramMOAddress, // _referrer address
      '', // _data bytes
    ],
    to: paramLockAddress,
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
};

const getDistinctAddresses = async (fid: string): Promise<Address[]> => {
  let fetchedUsers: any = await neynarClient.fetchBulkUsers([Number(fid)]);
  const ethAddresses: string[] =
    fetchedUsers.users[0]?.verified_addresses?.eth_addresses;
  return Array.from(
    new Set(
      (ethAddresses || [])
        .filter(
          (address) => typeof address === 'string' && address.startsWith('0x')
        )
        .map((address) => address as Address)
    )
  );
};

const shortenAddress = (address: string): string => {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : '';
};

function isSetupCast(castText: string): boolean {
  // Conditional text has been set in the hook, but it's also validated here
  return (
    castText.trim().toLowerCase() === process.env.BOT_SETUP_TEXT!.toLowerCase()
  ); // Case-insensitive check
}

function getLastPartOfUrl(url: string) {
  const urlObj = new URL(url);
  const parts = urlObj.pathname.split('/');
  return parts[parts.length - 1];
}

const getChannel = async (rootParentUrl: string): Promise<Channel | null> => {
  // let channelId = getLastPartOfUrl(rootParentUrl);
  // let channels: Array<Channel> = (await neynarClient.searchChannels(channelId)).channels;
  let channels: Array<Channel> = (
    await neynarClient.fetchBulkChannels([rootParentUrl], {
      type: ChannelType.ParentUrl,
    })
  ).channels;
  if (channels && channels.length > 0) {
    return channels[0];
  } else {
    return null;
  }
};

devtools(app, { serveStatic });

export const GET = handle(app);
export const POST = handle(app);
