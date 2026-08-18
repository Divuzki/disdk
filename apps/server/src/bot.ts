import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { formatTokenAmount } from '@disdk/protocol';
import { isSweepOperator, type ServerConfig } from './config.ts';
import type { Notifier } from './services.ts';

/** Button id for the sweep confirmation, suffixed with the invoking user's id. */
const SWEEP_CONFIRM_PREFIX = 'disdk:sweep:confirm:';

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
 * Operator-only. Registered only when the sweep feature is configured, only into
 * a specific guild, and with `default_member_permissions: '0'` so it is hidden
 * from everyone until a server admin grants it deliberately.
 *
 * None of that is the security boundary — the server-side allowlist is. This
 * only keeps the command from appearing to people who could never use it.
 */
const SWEEP_COMMAND = {
  name: 'sweep',
  description: 'Operator only: move your USDC to the configured cold wallet',
  default_member_permissions: '0',
  dm_permission: false,
};

/**
 * Commands to register. `/sweep` is added only when the feature is on *and* a
 * guild is configured — a global registration would publish an operator command
 * to every server the bot is in.
 */
function commandsFor(config: ServerConfig): unknown[] {
  if (!config.sweep) return COMMANDS;

  if (!config.discord.guildId) {
    console.warn(
      '[disdk] sweep is configured but DISCORD_GUILD_ID is not set. Skipping /sweep registration: it will not be published globally.',
    );
    return COMMANDS;
  }

  return [...COMMANDS, SWEEP_COMMAND];
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
      if (interaction.isButton()) {
        if (interaction.customId.startsWith(SWEEP_CONFIRM_PREFIX)) {
          await handleSweepConfirm(interaction, config, apiBase);
        }
        return;
      }
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
    case 'sweep':
      return promptSweepConfirmation(interaction, config);
  }
}

/**
 * First step of `/sweep`: say plainly what is about to happen and require a
 * second, explicit click before any session link exists.
 *
 * The allowlist check here is UX, not security — it produces an honest "not
 * authorized" instead of a link that would fail later. It is trivially bypassed
 * by calling the API directly, which is exactly why the server checks again at
 * session creation and again at issue time.
 */
async function promptSweepConfirmation(
  interaction: ChatInputCommandInteraction,
  config: ServerConfig,
): Promise<void> {
  if (!isSweepOperator(config.sweep, interaction.user.id)) {
    await interaction.reply({
      content: 'This command is not available to you.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sweep = config.sweep as NonNullable<ServerConfig['sweep']>;
  const rentTo = sweep.rentDestination === 'cold' ? 'the cold wallet' : 'your wallet';

  const confirm = new ButtonBuilder()
    .setCustomId(`${SWEEP_CONFIRM_PREFIX}${interaction.user.id}`)
    .setLabel('Yes, move my USDC')
    .setStyle(ButtonStyle.Danger);

  await interaction.reply({
    content: [
      '**This transfers funds. It cannot be undone.**',
      '',
      `You are about to move **${sweep.description}** to:`,
      `\`${sweep.coldWallet}\``,
      '',
      `Empty token accounts will then be closed, with the reclaimed rent going to ${rentTo}.`,
      '',
      'Unlike `/connect`, this is not an allowance and there is nothing to revoke afterwards —',
      'the tokens leave your wallet as soon as you sign. Continue only if that is what you want.',
    ].join('\n'),
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(confirm).toJSON()],
    flags: MessageFlags.Ephemeral,
  });
}

/** Second step of `/sweep`: the operator clicked through, so mint the link. */
async function handleSweepConfirm(
  interaction: ButtonInteraction,
  config: ServerConfig,
  apiBase: string,
): Promise<void> {
  // Re-checked on the click, not just on the command. The allowlist may have
  // changed while the prompt sat in the channel.
  if (!isSweepOperator(config.sweep, interaction.user.id)) {
    await interaction.reply({
      content: 'This command is not available to you.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // The button id carries the user it was issued for, so a relayed interaction
  // cannot act on someone else's prompt.
  const issuedFor = interaction.customId.slice(SWEEP_CONFIRM_PREFIX.length);
  if (issuedFor !== interaction.user.id) {
    await interaction.reply({
      content: 'This confirmation was not issued for you.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();
  await sendSweepLink(interaction, config, apiBase);
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

/**
 * Mint the sweep session and hand back the link. Reached only after the
 * confirmation click, and rejected server-side regardless if the caller is not
 * an operator.
 */
async function sendSweepLink(
  interaction: ButtonInteraction,
  config: ServerConfig,
  apiBase: string,
): Promise<void> {
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
      intent: 'sweep',
      interactionToken: interaction.token,
    }),
  });

  if (!response.ok) {
    // A 401 here means the server refused the sweep — the allowlist is the
    // authority, and the bot reports its answer rather than working around it.
    await interaction.editReply({
      content:
        response.status === 401
          ? 'This command is not available to you.'
          : 'Could not create a link right now. Please try again.',
      components: [],
    });
    return;
  }

  const { url, expiresAt } = (await response.json()) as { url: string; expiresAt: string };
  const minutes = Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 60_000));
  const sweep = config.sweep as NonNullable<ServerConfig['sweep']>;

  await interaction.editReply({
    content: [
      '**Confirmed — open the link to sign**',
      '',
      url,
      '',
      `Moving **${sweep.description}** to \`${sweep.coldWallet}\`.`,
      'You will sign twice: once to transfer, once to close empty accounts.',
      'The transfer lands on its own, so a token account that cannot be closed will not undo it.',
      '',
      `The link expires in ${minutes} minutes. We pay the network fee.`,
    ].join('\n'),
    components: [],
  });
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
