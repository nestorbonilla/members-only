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
    
    console.log('hook-setup => status: ', status);
    
    const body = await req.json();
    let cast: Cast = body.data;
    console.log('hook-setup => cast: ', cast);
    console.log('hook-setup => root_parent_url: ', cast.root_parent_url);

    // 1. Validate the cast author is the owner of the channel
    // 1.1 Get the channel owner
    let channel = await getChannel(cast.root_parent_url!);
    console.log('hook-setup => channel: ', channel);
    let channelId = channel?.id;
    let channelLead = channel?.lead?.fid;

    // 1.2 Get the cast author
    let castAuthor = cast.author.fid;

    // 1.3 Compare the channel owner and the cast author and validate the cast text is "@membersonly setup"
    let castText = cast.text;
    
    console.log('hook-setup => channelLead: ', channelLead);
    console.log('hook-setup => castAuthor: ', castAuthor);

    if (channelLead == castAuthor) {
      if (castText == process.env.BOT_SETUP_TEXT) {
        console.log('hook-setup => before publish cast: ');
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
        console.log('hook-setup => castResponse: ', castResponse);
        if (castResponse.hash) {
          // Now let's update the validate hook
          const webhooks = await neynarClient.fetchWebhooks().then((res) => res.webhooks);
            console.log('hook-setup => webhooks: ', webhooks);
          const targetWebhook = webhooks.find(
            (webhook) => webhook.title === process.env.MO_HOOK_VALIDATE_TITLE
          );
          console.log('hook-setup => targetWebhook: ', targetWebhook);
          if (
            !targetWebhook ||
            !targetWebhook.subscription ||
            !targetWebhook.subscription.filters['cast.created']
          ) {
            console.log('hook-setup => no hook found');
            throw new Error(
              `Webhook with title "${process.env.MO_HOOK_VALIDATE_TITLE}" or its filters not found.`
            );
          } else {
            const castCreatedFilter = targetWebhook.subscription.filters['cast.created'];
            console.log('hook-setup => castCreatedFilter: ', castCreatedFilter);
            let rootParentUrls = castCreatedFilter.root_parent_urls || [];
            console.log('hook-setup => rootParentUrls: ', rootParentUrls);
            // Ensure channel is defined
            if (channel && channel.url && channel.parent_url) {
              const textFound = rootParentUrls.some((url: string) => url.includes(channel.url));
              console.log('hook-setup => textFound: ', textFound);

              if (!textFound) {
                  console.log('hook-setup => before updateWebhook: ');
                  const updatedRootParentUrls = [...new Set([...rootParentUrls, channel.parent_url])]; // Remove duplicates
                  console.log('hook-setup => updatedRootParentUrls: ', updatedRootParentUrls);
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

                  console.log('hook-setup => updateWebhook: ', updateWebhook);
                  updateWebhook.success
                      ? console.log('Validate webhook updated successfully')
                      : console.log('Failed to update validate webhook');
              }
            } else {
              console.error("Channel information is missing or incomplete");
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
    console.log('call start: frame-purchase/:channelId');
    const { buttonValue, status, req } = c;
    let ethAddresses: string[] = [];
    let channelId = req.param('channelId');
    let textFrame = '';
    let dynamicImage = '';
    let dynamicIntents: any[] = [];
    let totalKeysCount = 0;
    let erc20Allowance = BigInt(0);
    let lockTokenSymbol = '';
    let lockTokenDecimals = 18; // most ERC20 tokens have 18 decimals
    let lockTokenPriceVisual = '';

    // Get the channel access rules
    let channelRules = await getChannelRules(channelId!);
    if (
      status == 'initial' ||
      (status == 'response' && buttonValue == 'done')
    ) {
      // Step 1: Show the number of rules on the channel
      dynamicImage = `/api/frame-purchase-initial-image/${channelId}/${channelRules?.length}`;
      dynamicIntents = [<Button value="verify">verify</Button>];
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
            let tokenId = await getFirstTokenIdOfOwner(
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
            if (membershipIsValidForAtLeastOneAddress) {
              console.log(
                statusMessage[ApiRoute.FRAME_PURCHASE][
                  FramePurchaseResult.FRAME_MEMBERSHIP_VALID
                ]
              );
              // if membership is valid, then if it's renewable
              let keyExpirationInSeconds = await getTokenExpiration(
                tokenId,
                currentRule.contract_address,
                currentRule.network
              );
              dynamicImage = `/api/frame-purchase-rule-image/${channelId}/${currentRule.network}/${lockName}/true/${lockTokenSymbol}/${lockTokenPriceVisual}/${keyExpirationInSeconds}`;
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
              dynamicImage = `/api/frame-purchase-rule-image/${channelId}/${currentRule.network}/${lockName}/false/${lockTokenSymbol}/${lockTokenPriceVisual}/0`;

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
                  !membershipIsValidForAtLeastOneAddress &&
                  totalKeysCount == 0
                ) {
                  return (
                    // /tx-purchase/:lockAddress/:network/:ethAddress
                    <Button.Transaction
                      target={`/tx-purchase/${currentRule.network}/${currentRule.contract_address}/${ethAddresses[0]}`}
                    >
                      buy
                    </Button.Transaction>
                  );
                }
              };

              const renewBtn = async () => {
                if (erc20Allowance >= lockPrice && totalKeysCount > 0) {
                  // Before renewing the key, let's verify if it is renewable
                  let isRenewable = true;
                  if (isRenewable) {
                    // One or more keys are expired, so let's renew the first we found
                    if (tokenId > 0) {
                      return (
                        // /tx-renew/:network/:lockAddress/:tokenId/:price
                        <Button.Transaction
                          target={`/tx-renew/${currentRule.network}/${currentRule.contract_address}/${tokenId}/${lockPrice}`}
                        >
                          renew
                        </Button.Transaction>
                      );
                    }
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
            dynamicImage = `/api/frame-purchase-no-rules-image/${channelId}`;
            dynamicIntents = [<Button value="verify">verify</Button>];
          }
        } else if (buttonValue?.startsWith('approval-')) {
          dynamicImage = `/api/frame-purchase-approval-image/${channelId}`;
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
          dynamicImage = `/api/frame-tx-submitted-image/${channelId}`;
          dynamicIntents = [<Button value="done">continue</Button>];
        }
      } else {
        dynamicImage = `/api/frame-purchase-no-address-image/${channelId}`;
      }
    }
    return c.res({
      title: 'Members Only - Membership Purchase',
      image: dynamicImage,
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
  let dynamicImage = '';
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
    // Step 1: Show the number of rules on the channel
    let lockName;
    if (channelRules?.length! > 0) {
      lockName = await getLockName(
        channelRules![0].contract_address,
        channelRules![0].network
      );
    }
    dynamicImage = `/api/frame-setup-initial-image/${channelId}/${conditions}`;
    if (channelRules?.length! == 0) {
      dynamicIntents = [<Button value="add">add</Button>];
    } else {
      if (conditions >= Number(process.env.ACCESS_RULES_LIMIT)) {
        dynamicIntents = [<Button value="remove">remove</Button>];
      } else {
        dynamicIntents = [
          <Button value="add">add</Button>,
          <Button value="remove">remove</Button>,
        ];
      }
    }
  } else if (status == 'response') {
    if (interactorIsChannelLead) {
      // Step 2: Show action to achieve, either add or remove a rule
      if (buttonValue == 'add' || buttonValue == 'remove') {
        if (buttonValue == 'add') {
          dynamicImage = `/api/frame-setup-network-image/${channelId}`;
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
            dynamicImage = `/api/frame-setup-no-rules-image/${channelId}`;
            dynamicIntents = [<Button value="done">back</Button>];
          } else {
            let currentRule = channelRules[0];
            let firstContractAddress = currentRule.contract_address;
            let lockName = await getLockName(
              currentRule.contract_address,
              currentRule.network
            );
            dynamicImage = `/api/frame-setup-remove-rule-image/${channelId}/${currentRule.network}/${lockName}/${currentRule.contract_address}`;
            dynamicIntents = [
              nextBtn(1),
              <Button value={`removeconfirm-${firstContractAddress}`}>
                confirm remove
              </Button>,
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

        if (contractAddresses.length > 0) {
          let lockName = await getLockName(contractAddresses[0], network);
          let currentLock = 1;
          let totalLocks = contractAddresses.length;
          // here i need to add an extra step, if not I'm asking for the referral fee automatically
          dynamicImage = `/api/frame-setup-add-rule-image/${channelId}/${network}/${lockName}/${contractAddresses[0]}/${currentLock}/${totalLocks}`;
          dynamicIntents = [
            <TextInput placeholder="contract address..." />,
            nextBtn(0),
            <Button value={`addconfirm-${network}-${contractAddresses[0]}`}>
              confirm
            </Button>,
            <Button value={`addconfirm-${network}-${process.env.ZERO_ADDRESS}`}>
              custom
            </Button>,
          ];
        } else {
          dynamicImage = `/api/frame-setup-no-lock-image/${channelId}`;
          dynamicIntents = [
            <TextInput placeholder="contract address..." />,
            <Button value={`addconfirm-${network}-${process.env.ZERO_ADDRESS}`}>
              custom
            </Button>,
          ];
        }

        console.log('network selection: end');
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
        dynamicImage = `/api/frame-setup-add-rule-image/${channelId}/${network}/${lockName}/${contractAddresses[currentPage]}/${currentLock}/${totalLocks}`;
        dynamicIntents = [
          <TextInput placeholder="contract address..." />,
          prevBtn(currentPage),
          nextBtn(currentPage),
          <Button
            value={`addconfirm-${network}-${contractAddresses[currentPage]}`}
          >
            confirm
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
        if (referralFee < process.env.MO_MINIMUM_REFERRAL_FEE!) {
          let lockName = await getLockName(contractAddress, network);
          dynamicImage = `/api/frame-setup-referrer-fee-image/${channelId}/${network}/${lockName}/${contractAddress}`;
          dynamicIntents = [
            <TextInput placeholder="custom referrer fee..." />,
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
            dynamicImage = `/api/frame-setup-repeated-rule-image/${channelId}`;
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
              dynamicImage = `/api/frame-setup-add-error-rule-image/${channelId}`;
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
              dynamicImage = `/api/frame-setup-add-complete-rule-image/${channelId}`;
              dynamicIntents = [<Button value={'done'}>complete</Button>];
            }
          }
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
        dynamicImage = `/api/frame-setup-remove-rule-image/${channelId}/${currentRule.network}/${lockName}/${currentRule.contract_address}`;
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
            confirm remove
          </Button>,
        ];
        console.log('removepage-: end');
      } else if (buttonValue!.startsWith('removeconfirm-')) {
        console.log('removeconfirm-: start');
        let [_, contractAddress] = buttonValue!.split('-');
        let deleteError = await deleteChannelRule(channelId, contractAddress);
        if (deleteError) {
          dynamicImage = `/api/frame-setup-remove-error-rule-image/${channelId}`;
          dynamicIntents = [
            <Button value={'done'}>Restart</Button>,
            <Button value={`removeconfirm-${contractAddress}`}>
              try again
            </Button>,
          ];
        } else {
          dynamicImage = `/api/frame-setup-remove-complete-rule-image/${channelId}`;
          dynamicIntents = [<Button value={'done'}>complete</Button>];
        }
        console.log('removeconfirm-: end');
      } else if (buttonValue == '_t') {
        dynamicImage = `/api/frame-tx-submitted-image/${channelId}`;
        dynamicIntents = [<Button value="done">continue</Button>];
      }
    } else {
      textFrame =
        'This is a @membersonly frame to configure rules, know more about me at my profile.';
      dynamicImage = `/api/frame-setup-no-access-image/${channelId}`;
      dynamicIntents = [];
    }
  }
  console.log('call end: frame-setup-channel/:channelId');
  return c.res({
    title: 'Members Only - Channel Setup',
    image: dynamicImage,
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
  '/tx-purchase/:network/:lockAddress/:userAddress',
  async (c) => {
    const { req } = c;
    let network = req.param('network');
    let lockAddress = req.param('lockAddress');
    let userAddress = req.param('userAddress');
    let lockPrice = await getLockPrice(lockAddress, network);

    let paramLockAddress = lockAddress as `0x${string}`;
    let paramUserAddress = userAddress as `0x${string}`;
    let paramMOAddress = process.env.MO_ADDRESS as `0x${string}`;
    let paramLockPrice = BigInt(lockPrice);
    type EipChainId = 'eip155:8453' | 'eip155:10' | 'eip155:42161';
    let paramChainId: EipChainId = getEipChainId(network);

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

app.image(
  '/frame-purchase-initial-image/:channelId/:rulesCount',
  neynarMiddleware,
  (c) => {
    const { channelId, rulesCount } = c.req.param();
    let textFrame = '';
    if (parseInt(rulesCount) == 0) {
      textFrame = `This channel is currently open to everyone, as a channel lead, you can make it members only!`;
    } else {
      textFrame = `This channel currently requires ${rulesCount} ${parseInt(rulesCount) != 1 ? 'memberships' : 'membership'}. To purchase or renew one, lets start by veryfing some data.`;
    }
    return c.res({
      imageOptions: {
        headers: {
          'Cache-Control': 'max-age=0',
        },
      },
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
    });
  }
);

app.image(
  '/frame-purchase-rule-image/:channelId/:network/:lockName/:isValid/:lockTokenSymbol/:lockTokenPriceVisual/:keyExpirationInSeconds',
  neynarMiddleware,
  (c) => {
    const {
      channelId,
      network,
      lockName,
      isValid,
      lockTokenSymbol,
      lockTokenPriceVisual,
      keyExpirationInSeconds,
    } = c.req.param();
    let textDescription = '';
    let textPrice = '';
    const booleanMap = new Map([
      ['true', true],
      ['false', false],
    ]);

    if (booleanMap.get(isValid)) {
      let keyExpirationMiliseconds = new Date(
        Number(keyExpirationInSeconds) * 1000
      ); // Convert to milliseconds
      const options: Intl.DateTimeFormatOptions = {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        timeZoneName: 'short', // Optional: Show timezone
      };
      let keyExpirationString = keyExpirationMiliseconds.toLocaleString(
        undefined,
        options
      );
      textDescription = ` You own a valid membership for the lock "${lockName}", deployed on ${network} network, and is valid til ${keyExpirationString}`;
      return c.res({
        imageOptions: {
          headers: {
            'Cache-Control': 'max-age=0',
          },
        },
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
                {textDescription}
              </Text>
            </VStack>
          </Box>
        ),
      });
    } else {
      textDescription = ` You dont own a valid membership for the lock "${lockName}", deployed on ${network} network.`;
      textPrice = `It costs ${lockTokenPriceVisual} ${lockTokenSymbol} to purchase a key.`;
      return c.res({
        imageOptions: {
          headers: {
            'Cache-Control': 'max-age=0',
          },
        },
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
                {textDescription}
              </Text>
              <Spacer size="10" />
              <Text color={'black'} size="18">
                {textPrice}
              </Text>
            </VStack>
          </Box>
        ),
      });
    }
  }
);

app.image('/frame-tx-submitted-image/:channelId', neynarMiddleware, (c) => {
  const { channelId } = c.req.param();
  let textDescription = `Your tx has been submitted to the blockchain, please wait a few seconds, and then click on complete.`;

  return c.res({
    imageOptions: {
      headers: {
        'Cache-Control': 'max-age=0',
      },
    },
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
            {textDescription}
          </Text>
        </VStack>
      </Box>
    ),
  });
});

app.image(
  '/frame-purchase-approval-image/:channelId',
  neynarMiddleware,
  (c) => {
    const { channelId } = c.req.param();
    let textDescription = `Do you want to approve one time (default), or multiple times? (set a number higher than 1)`;

    return c.res({
      imageOptions: {
        headers: {
          'Cache-Control': 'max-age=0',
        },
      },
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
              {textDescription}
            </Text>
          </VStack>
        </Box>
      ),
    });
  }
);

app.image(
  '/frame-purchase-no-address-image/:channelId',
  neynarMiddleware,
  (c) => {
    const { channelId } = c.req.param();
    let textDescription = `It seems you dont have any eth address verified. Please verify at least one address to proceed.`;

    return c.res({
      imageOptions: {
        headers: {
          'Cache-Control': 'max-age=0',
        },
      },
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
              {textDescription}
            </Text>
          </VStack>
        </Box>
      ),
    });
  }
);

app.image(
  '/frame-purchase-no-rules-image/:channelId',
  neynarMiddleware,
  (c) => {
    const { channelId } = c.req.param();
    let textDescription = `It seems there are no rules currently to purchase for this channel. Please contact the channel lead to add rules.`;

    return c.res({
      imageOptions: {
        headers: {
          'Cache-Control': 'max-age=0',
        },
      },
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
              {textDescription}
            </Text>
          </VStack>
        </Box>
      ),
    });
  }
);

app.image(
  '/frame-setup-initial-image/:channelId/:rulesCount',
  neynarMiddleware,
  (c) => {
    const { channelId, rulesCount } = c.req.param();
    let textFrame = `This channel has ${rulesCount} ${parseInt(rulesCount) != 1 ? 'rules' : 'rule'}. As channel lead, you can add or remove rules.`;
    return c.res({
      imageOptions: {
        headers: {
          'Cache-Control': 'max-age=0',
        },
      },
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
    });
  }
);

app.image('/frame-setup-network-image/:channelId', neynarMiddleware, (c) => {
  const { channelId } = c.req.param();
  let textFrame = `Start by selecting the network on which the membership contract has ben deployed.`;
  return c.res({
    imageOptions: {
      headers: {
        'Cache-Control': 'max-age=0',
      },
    },
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
  });
});

app.image('/frame-setup-no-rules-image/:channelId', neynarMiddleware, (c) => {
  const { channelId } = c.req.param();
  let textFrame = `There are no rules to remove on this channel.`;
  return c.res({
    imageOptions: {
      headers: {
        'Cache-Control': 'max-age=0',
      },
    },
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
  });
});

app.image(
  '/frame-setup-repeated-rule-image/:channelId',
  neynarMiddleware,
  (c) => {
    const { channelId } = c.req.param();
    let textFrame = `A rule with this membership already exists. Please select another membership.`;
    return c.res({
      imageOptions: {
        headers: {
          'Cache-Control': 'max-age=0',
        },
      },
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
    });
  }
);

app.image('/frame-setup-no-lock-image/:channelId', neynarMiddleware, (c) => {
  const { channelId } = c.req.param();
  let textFrame =
    'There are no locks deployed from your accounts, please set one on the input and click confirm. (It must be an Unlock contract)';
  return c.res({
    imageOptions: {
      headers: {
        'Cache-Control': 'max-age=0',
      },
    },
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
  });
});

app.image('/frame-setup-no-access-image/:channelId', neynarMiddleware, (c) => {
  const { channelId } = c.req.param();
  let textFrame =
    'To access this frame, you need to be the owner of the this channel.';
  return c.res({
    imageOptions: {
      headers: {
        'Cache-Control': 'max-age=0',
      },
    },
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
  });
});

app.image(
  '/frame-setup-referrer-fee-image/:channelId/:network/:lockName/:lockAddress',
  neynarMiddleware,
  (c) => {
    const { channelId, network, lockName, lockAddress } = c.req.param();
    let textFrame = `To add a rule with the lock "${lockName}" (${shortenAddress(lockAddress)}) deployed on ${network} network, please add a min. of 5% of referral fee to @membersonly for future purchases or renewals.`;
    return c.res({
      imageOptions: {
        headers: {
          'Cache-Control': 'max-age=0',
        },
      },
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
    });
  }
);

app.image(
  '/frame-setup-add-rule-image/:channelId/:network/:lockName/:lockAddress/:currentLock/:totalLocks',
  neynarMiddleware,
  (c) => {
    const {
      channelId,
      network,
      lockName,
      lockAddress,
      currentLock,
      totalLocks,
    } = c.req.param();
    let textFrame = `Do you want to add the lock "${lockName}" (${shortenAddress(lockAddress)}) deployed on ${network} network as a requirement to cast on this channel?`;
    return c.res({
      imageOptions: {
        headers: {
          'Cache-Control': 'max-age=0',
        },
      },
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
            <Spacer size="10" />
            <Text color={'black'} size="18">
              {currentLock} of {totalLocks}
            </Text>
          </VStack>
        </Box>
      ),
    });
  }
);

app.image(
  '/frame-setup-add-complete-rule-image/:channelId',
  neynarMiddleware,
  (c) => {
    const { channelId } = c.req.param();
    let textFrame = `The rule was added successfully.`;
    return c.res({
      imageOptions: {
        headers: {
          'Cache-Control': 'max-age=0',
        },
      },
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
    });
  }
);

app.image(
  '/frame-setup-add-error-rule-image/:channelId',
  neynarMiddleware,
  (c) => {
    const { channelId } = c.req.param();
    let textFrame = `There was an error trying to add the rule. Please, try again.`;
    return c.res({
      imageOptions: {
        headers: {
          'Cache-Control': 'max-age=0',
        },
      },
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
    });
  }
);

app.image(
  '/frame-setup-remove-rule-image/:channelId/:network/:lockName/:lockAddress',
  neynarMiddleware,
  (c) => {
    const { channelId, network, lockName, lockAddress } = c.req.param();
    let textFrame = `Do you want to remove the lock "${lockName}" (${shortenAddress(lockAddress)}) deployed on ${network} network as a requirement to cast on this channel?`;
    return c.res({
      imageOptions: {
        headers: {
          'Cache-Control': 'max-age=0',
        },
      },
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
    });
  }
);

app.image(
  '/frame-setup-remove-complete-rule-image/:channelId',
  neynarMiddleware,
  (c) => {
    const { channelId } = c.req.param();
    let textFrame = `The rule was removed successfully.`;
    return c.res({
      imageOptions: {
        headers: {
          'Cache-Control': 'max-age=0',
        },
      },
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
    });
  }
);

app.image(
  '/frame-setup-remove-error-rule-image/:channelId',
  neynarMiddleware,
  (c) => {
    const { channelId } = c.req.param();
    let textFrame = `There was an error trying to remove the rule. Please, try again.`;
    return c.res({
      imageOptions: {
        headers: {
          'Cache-Control': 'max-age=0',
        },
      },
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
    });
  }
);

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
