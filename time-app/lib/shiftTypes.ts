export const SHIFT_TYPES = [
  "Catering",
  "PENN Opener",
  "PENN Closer",
  "PENN Swing Shift",
  "PENN Weekend Closer",
  "Staff Meeting",
] as const;

export type ShiftType = (typeof SHIFT_TYPES)[number];
