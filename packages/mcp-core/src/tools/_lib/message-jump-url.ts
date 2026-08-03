import { container } from '@sapphire/pieces';
import { Routes } from 'discord-api-types/v10';

interface MessageLocation {
  id: string;
  channel_id: string;
  guild_id?: string;
}

interface ChannelLocation {
  guild_id?: string;
}

/**
 * Discord's create-message response may omit guild_id even for a guild channel.
 * Resolve the channel only in that case so returned message links point to the
 * actual guild instead of the DM-only @me namespace.
 */
export async function messageJumpUrl(message: MessageLocation): Promise<string> {
  let guildId = message.guild_id;

  if (guildId === undefined) {
    try {
      const channel = (await container.rest.get(
        Routes.channel(message.channel_id),
      )) as ChannelLocation;
      guildId = channel.guild_id;
    } catch (error) {
      // The message already exists. Preserve a successful send rather than
      // returning an error that could cause callers to retry and duplicate it.
      container.logger.warn(
        { err: error, channel_id: message.channel_id, message_id: message.id },
        'Could not resolve guild-aware message jump URL',
      );
    }
  }

  return `https://discord.com/channels/${guildId ?? '@me'}/${message.channel_id}/${message.id}`;
}
