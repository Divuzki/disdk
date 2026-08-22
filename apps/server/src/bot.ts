import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { ServerConfig } from './config.ts';
import type { Notifier } from './services.ts';

/**
 * The whole command surface.
 *
 * There is exactly one, and it mints a checkout. Nothing here grants an
 * allowance, so there is no status to report, nothing to top up, and nothing to
 * revoke — a payment is finished when it confirms and leaves nothing behind.
 */
const COMMANDS = [
  {
    name: 'connect',
    description: 'Pay USDC — you choose the amount and sign it yourself',
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
      return sendPayLink(interaction, config, apiBase);
  }
}

/**
 * Mint a checkout session with no merchant price, and hand back the link.
 *
 * No confirmation step and no operator allowlist: nobody here can name a price
 * for somebody else to pay, and the payer signs the transfer themselves while
 * looking at the resolved amount. The reply is ephemeral because the link is a
 * bearer token for one person's session and must not sit in a public channel
 * for anyone to click.
 */
async function sendPayLink(
  interaction: ChatInputCommandInteraction,
  config: ServerConfig,
  apiBase: string,
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
      intent: 'charge',
      // No amount: the server prices this from the payer's balance at connect
      // time. Nothing the bot knows could price it, and nothing should.
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
 * Notify Discord that a link completed, by editing the ephemeral reply the user
 * is still looking at.
 */
export function createDiscordNotifier(config: ServerConfig): Notifier {
  const { token, clientId } = config.discord;
  if (!token || !clientId) return { async onComplete() {} };

  const rest = new REST({ version: '10' }).setToken(token);

  return {
    async onComplete({ discordUserId, interactionToken, wallet, amountUi, symbol, explorerUrl }) {
      // Nothing about revoking: this moved funds and left nothing standing, so
      // there is nothing to undo and saying otherwise would be a lie told at the
      // moment it is least checkable.
      const content = [
        `**Payment sent** from \`${wallet}\``,
        `Paid **${amountUi} ${symbol}**.`,
        `[View transaction](${explorerUrl})`,
        '',
        'This was a one-off payment — nothing was left authorized on your wallet.',
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
