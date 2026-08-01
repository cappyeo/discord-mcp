// FIXTURE: synthetic PaSympa-style code for adapter testing - not real code.
export const listChannels = {
  name: 'discord_list_channels',
  description: 'List all channels in a guild',
};
export const createChannel = {
  name: 'discord_create_channel',
  description: 'Create a new channel in a guild',
};
// Synthetic unmappable tool to test the unmapped path. PaSympa does not
// actually ship `discord_audit_alert`; this exists purely to assert that
// names absent from NAME_MAP fall into `unmappedTools` (not `mappedTools`).
export const auditAlert = {
  name: 'discord_audit_alert',
  description: 'PaSympa-specific audit alert (no discord-mcp equivalent)',
};
