// FIXTURE: synthetic PaSympa-style code for adapter testing - not real code.
// The adapter regex matches `'discord_*'` / `"discord_*"` literals; the
// shape of the surrounding object only needs to expose `name:` strings.
export const sendMessage = {
  name: 'discord_send_message',
  description: 'Send a message to a Discord channel',
};
export const readMessages = {
  name: 'discord_read_messages',
  description: 'Read recent messages from a channel',
};
export const editMessage = {
  name: 'discord_edit_message',
  description: 'Edit a previously sent message',
};
