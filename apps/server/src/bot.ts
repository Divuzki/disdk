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
    { body: COMMANDS },
  );

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      await handleCommand(interaction, config, apiBase);
    } catch (error) {
      console.error('[disdk] command failed', error);
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
  }
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
