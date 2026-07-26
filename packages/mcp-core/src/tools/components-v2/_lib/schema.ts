import { z } from 'zod';

export const ComponentTypeId = {
  ActionRow: 1,
  Button: 2,
  StringSelect: 3,
  TextInput: 4,
  UserSelect: 5,
  RoleSelect: 6,
  MentionableSelect: 7,
  ChannelSelect: 8,
  Section: 9,
  TextDisplay: 10,
  Thumbnail: 11,
  MediaGallery: 12,
  File: 13,
  Separator: 14,
  Container: 17,
} as const;

const Emoji = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  animated: z.boolean().optional(),
});

const ButtonBase = z.object({
  type: z.literal(2),
  style: z.number().int().min(1).max(6),
  label: z.string().max(80).optional(),
  emoji: Emoji.optional(),
  disabled: z.boolean().optional(),
});
export const Button = z.union([
  ButtonBase.extend({ custom_id: z.string().min(1).max(100), url: z.never().optional() }),
  ButtonBase.extend({ url: z.string().url(), custom_id: z.never().optional() }),
]);

const SelectOption = z.object({
  label: z.string().max(100),
  value: z.string().max(100),
  description: z.string().max(100).optional(),
  emoji: Emoji.optional(),
  default: z.boolean().optional(),
});

const SelectBase = z.object({
  custom_id: z.string().min(1).max(100),
  placeholder: z.string().max(150).optional(),
  min_values: z.number().int().min(0).max(25).default(1),
  max_values: z.number().int().min(1).max(25).default(1),
  disabled: z.boolean().optional(),
});
const StringSelect = SelectBase.extend({
  type: z.literal(3),
  options: z.array(SelectOption).min(1).max(25),
});
const UserSelect = SelectBase.extend({ type: z.literal(5) });
const RoleSelect = SelectBase.extend({ type: z.literal(6) });
const MentionableSelect = SelectBase.extend({ type: z.literal(7) });
const ChannelSelect = SelectBase.extend({
  type: z.literal(8),
  channel_types: z.array(z.number().int()).optional(),
});

const TextDisplay = z.object({
  type: z.literal(10),
  content: z.string().min(1).max(4000),
});

const Thumbnail = z.object({
  type: z.literal(11),
  media: z.object({ url: z.string().url() }),
  description: z.string().max(1024).optional(),
  spoiler: z.boolean().optional(),
});

const Section = z.object({
  type: z.literal(9),
  components: z.array(TextDisplay).min(1).max(3),
  accessory: z.union([Thumbnail, Button]),
});

const MediaGalleryItem = z.object({
  media: z.object({ url: z.string().url() }),
  description: z.string().max(1024).optional(),
  spoiler: z.boolean().optional(),
});
const MediaGallery = z.object({
  type: z.literal(12),
  items: z.array(MediaGalleryItem).min(1).max(10),
});

const File = z.object({
  type: z.literal(13),
  file: z.object({ url: z.string() }),
  spoiler: z.boolean().optional(),
});

const Separator = z.object({
  type: z.literal(14),
  divider: z.boolean().optional(),
  spacing: z.number().int().min(1).max(2).optional(),
});

const Select = z.discriminatedUnion('type', [
  StringSelect,
  UserSelect,
  RoleSelect,
  MentionableSelect,
  ChannelSelect,
]);

const ActionRow = z.object({
  type: z.literal(1),
  components: z
    .array(z.union([Button, Select]))
    .min(1)
    .max(5),
});

const Container: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    type: z.literal(17),
    components: z
      .array(z.union([Section, TextDisplay, MediaGallery, File, Separator, ActionRow]))
      .min(1)
      .max(10),
    accent_color: z.number().int().min(0).max(0xffffff).nullish(),
    spoiler: z.boolean().optional(),
  }),
);

export const ComponentV2 = z.union([
  ActionRow,
  Button,
  StringSelect,
  UserSelect,
  RoleSelect,
  MentionableSelect,
  ChannelSelect,
  Section,
  TextDisplay,
  Thumbnail,
  MediaGallery,
  File,
  Separator,
  Container as z.ZodType<{ type: 17 } & Record<string, unknown>>,
]);

export const ComponentsV2Array = z.array(ComponentV2).min(1).max(40);

export type ComponentV2Input = z.infer<typeof ComponentV2>;
