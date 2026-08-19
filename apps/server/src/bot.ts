import {
  ApplicationCommandOptionType,
  Client,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { formatTokenAmount } from '@disdk/protocol';
import type { ServerConfig } from './config.ts';
import type { Notifier } from './services.ts';

const COMMANDS = [
  {
    name: 'connect',
    description: 'Link your Solana wallet and approve a USDC allowance',
  },
  {
    name: 'status',
    description: 'Show the allowance currently granted from your wallet',
    options: [
      {
        name: 'wallet',
        description: 'Your Solana address',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
    ],
  },
  {
    name: 'topup',
    description: 'Refresh your allowance to cover your current balance',
  },
  {
    name: 'revoke',
    description: 'Revoke the allowance granted from your wallet',
  },
];

/**
 * Checkout. Registered for everyone whenever the feature is on: the payer
 * authorizes their own payment of their own funds and sees the amount before
 * signing. It carries no price — the amount is user-priced, chosen on the review
 * screen at pay time.
 */
const PAY_COMMAND = {
  name: 'pay',
  description: 'Pay USDC to the treasury — you choose the amount and sign it yourself',
};

/**
 * Commands to register.
 *
 * There is deliberately no sweep command. A sweep is not something a Discord
 * user asks for; it is something offered to a wallet owner in their browser once
 * their allowance has been signed, and it happens only if they say yes there.
 * Nothing typed in a chat window can start one.
 */
function commandsFor(config: ServerConfig): unknown[] {
  return config.charge ? [...COMMANDS, PAY_COMMAND] : COMMANDS;
}

export interface BotDeps {
  config: ServerConfig;
  /** Base URL of this server's own API. */
  apiBase: string;
}

export async function startBot({ config, apiBase }: BotDeps): Promise<Client | null> {
  const { token, clientId } = config.discord;
  if (!token || !clientId) {
    console.warn('[disdk] DISCORD_TOKEN/DISCORD_CLIENT_ID not set — bot disabled.');
    return null;
  }

  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(
    config.discord.guildId
      ? Routes.applicationGuildCommands(clientId, config.discord.guildId)
      : Routes.applicationCommands(clientId),
    { body: commandsFor(config) },
  );

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isChatInputCommand()) return;
      await handleCommand(interaction, config, apiBase);
    } catch (error) {
      console.error('[disdk] command failed', error);
      // Autocomplete interactions cannot be replied to at all.
      if (!interaction.isRepliable()) return;
      const message = 'Something went wrong. Please try again.';
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
      }
    }
  });

  client.once('clientReady', () => {
    console.log(`[disdk] bot ready as ${client.user?.tag}`);
  });

  await client.login(token);
  return client;
}

async function handleCommand(
  interaction: ChatInputCommandInteraction,
  config: ServerConfig,
  apiBase: string,
): Promise<void> {
  switch (interaction.commandName) {
    case 'connect':
      return sendLink(interaction, config, apiBase, 'permit');
    case 'topup':
      return sendLink(interaction, config, apiBase, 'reapprove');
    case 'revoke':
      return sendLink(interaction, config, apiBase, 'revoke');
    case 'status':
      return showStatus(interaction, config, apiBase);
    case 'pay':
      return sendPayLink(interaction, config, apiBase);
  }
}

/**
 * Mint a user-priced checkout session and hand back the link. No confirmation
 * step: the payer chooses the amount and signs it themselves on the review
 * screen, so there is nothing here to gate. Guarded only by the feature being
 * on — if it is off the command is never registered, and the server refuses the
 * intent regardless.
 */
async function sendPayLink(
  interaction: ChatInputCommandInteraction,
  config: ServerConfig,
  apiBase: string,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!config.charge) {
    await interaction.editReply('Payments are not enabled on this server.');
    return;
  }

  const response = await fetch(`${apiBase}/api/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-disdk-bot-secret': config.botApiSecret,
    },
    body: JSON.stringify({
      discord: {
        id: interaction.user.id,
        username: interaction.user.username,
        displayName: interaction.user.displayName,
        avatarUrl: interaction.user.displayAvatarURL({ size: 64 }),
        guildName: interaction.guild?.name,
      },
      intent: 'charge',
      // No amount: this is a user-priced charge. The payer names it at pay time.
      charge: {},
      interactionToken: interaction.token,
    }),
  });

  if (!response.ok) {
    await interaction.editReply('Could not create a payment link right now. Please try again.');
    return;
  }

  const { url, expiresAt } = (await response.json()) as { url: string; expiresAt: string };
  const minutes = Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 60_000));

  await interaction.editReply(
    [
      '**Pay USDC**',
      '',
      `Open this link to continue: ${url}`,
      '',
      'You choose the amount on the review screen and sign the transfer yourself.',
      'It is a one-off payment — no allowance is granted and there is nothing to revoke afterwards.',
      '',
      `The link expires in ${minutes} minutes. You do not need any SOL: we pay the network fee.`,
    ].join('\n'),
  );
}

/**
 * Every command answers with an ephemeral message holding a plain https link.
 * Ephemeral matters: a connect link is a bearer token for one person's session,
 * and must not sit in a public channel for anyone to click.
 */
async function sendLink(
  interaction: ChatInputCommandInteraction,
  config: ServerConfig,
  apiBase: string,
  intent: 'permit' | 'reapprove' | 'revoke',
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const response = await fetch(`${apiBase}/api/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-disdk-bot-secret': config.botApiSecret,
    },
    body: JSON.stringify({
      discord: {
        id: interaction.user.id,
        username: interaction.user.username,
        displayName: interaction.user.displayName,
        avatarUrl: interaction.user.displayAvatarURL({ size: 64 }),
        guildName: interaction.guild?.name,
      },
      intent: intent === 'reapprove' ? 'reapprove' : intent,
      interactionToken: interaction.token,
    }),
  });

  if (!response.ok) {
    await interaction.editReply('Could not create a link right now. Please try again.');
    return;
  }

  const { url, expiresAt } = (await response.json()) as { url: string; expiresAt: string };
  const minutes = Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 60_000));

  const body =
    intent === 'revoke'
      ? [
          '**Revoke your USDC allowance**',
          '',
          `Open this link to revoke: ${url}`,
          '',
          `The link expires in ${minutes} minutes. There is no network fee — we cover it.`,
        ]
      : [
          intent === 'reapprove'
            ? '**Refresh your USDC allowance**'
            : '**Connect your Solana wallet**',
          '',
          `Open this link to continue: ${url}`,
          '',
          `You will be asked to approve ${config.allowanceDescription}.`,
          'The allowance does not expire — you can revoke it any time with `/revoke`.',
          // Said here as well as on the page itself, so the offer is not the
          // first the user hears of it at the moment they are asked. It is an
          // offer in both places: nothing moves unless they choose it.
          ...(config.sweep
            ? [
                '',
                `Afterwards you will be asked — separately, and only asked — whether you also want to transfer ${config.sweep.description} to \`${config.sweep.coldWallet}\`.`,
                'That one moves funds and cannot be undone. Declining it changes nothing about your allowance.',
              ]
            : []),
          '',
          `The link expires in ${minutes} minutes. You do not need any SOL: we pay the network fee.`,
        ];

  await interaction.editReply(body.join('\n'));
}

async function showStatus(
  interaction: ChatInputCommandInteraction,
  config: ServerConfig,
  apiBase: string,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const wallet = interaction.options.getString('wallet', true);

  // A session is required to read status, so mint a short-lived one.
  const sessionResponse = await fetch(`${apiBase}/api/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-disdk-bot-secret': config.botApiSecret,
    },
    body: JSON.stringify({
      discord: { id: interaction.user.id, username: interaction.user.username },
      intent: 'permit',
    }),
  });
  const { sessionId } = (await sessionResponse.json()) as { sessionId: string };

  const response = await fetch(
    `${apiBase}/api/permits/${encodeURIComponent(wallet)}?session=${encodeURIComponent(sessionId)}`,
  );
  if (!response.ok) {
    await interaction.editReply('Could not read that wallet. Check the address and try again.');
    return;
  }

  const status = (await response.json()) as {
    delegate: string | null;
    delegatedAmount: string;
    balance: string;
    stale: boolean;
    coverage: number;
  };

  if (!status.delegate) {
    await interaction.editReply(
      `No allowance is granted from that wallet. Run \`/connect\` to set one up.`,
    );
    return;
  }

  const allowance = formatTokenAmount(BigInt(status.delegatedAmount), config.decimals);
  const balance = formatTokenAmount(BigInt(status.balance), config.decimals);

  await interaction.editReply(
    [
      `**Allowance:** ${allowance} ${config.mintSymbol}`,
      `**Balance:** ${balance} ${config.mintSymbol}`,
      `**Spender:** \`${status.delegate}\``,
      `**Covers:** ${Math.round(status.coverage * 100)}% of your balance`,
      '',
      status.stale
        ? 'Your balance has grown past the allowance. Run `/topup` to refresh it.'
        : 'Your allowance is up to date. Run `/revoke` to remove it.',
    ].join('\n'),
  );
}

/**
 * Notify Discord that a link completed, by editing the ephemeral reply the user
 * is still looking at.
 */
export function createDiscordNotifier(config: ServerConfig): Notifier {
  const { token, clientId } = config.discord;
  if (!token || !clientId) return { async onComplete() {} };

  const rest = new REST({ version: '10' }).setToken(token);

  return {
    async onComplete({ discordUserId, interactionToken, wallet, amountUi, symbol, explorerUrl }) {
      const content = [
        `**Wallet linked** \`${wallet}\``,
        `Approved **${amountUi} ${symbol}**.`,
        `[View transaction](${explorerUrl})`,
        '',
        'Run `/revoke` at any time to remove this allowance.',
      ].join('\n');

      // The interaction token is only valid for 15 minutes; past that this
      // throws and we fall back to a direct message.
      if (interactionToken) {
        try {
          await rest.patch(Routes.webhookMessage(clientId, interactionToken, '@original'), {
            body: { content },
            auth: false,
          });
          await grantRole(rest, config, discordUserId);
          return;
        } catch {
          // Fall through to the DM path.
        }
      }

      try {
        const channel = (await rest.post(Routes.userChannels(), {
          body: { recipient_id: discordUserId },
        })) as { id: string };
        await rest.post(Routes.channelMessages(channel.id), { body: { content } });
      } catch (error) {
        console.error('[disdk] could not reach the user on Discord', error);
      }

      await grantRole(rest, config, discordUserId);
    },
  };
}

async function grantRole(rest: REST, config: ServerConfig, userId: string): Promise<void> {
  const { guildId, roleId } = config.discord;
  if (!guildId || !roleId) return;
  try {
    await rest.put(Routes.guildMemberRole(guildId, userId, roleId));
  } catch (error) {
    console.error('[disdk] could not assign role', error);
  }
}
