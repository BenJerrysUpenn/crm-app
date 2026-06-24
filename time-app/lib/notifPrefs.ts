// Notification preference definitions. Keys match the `type` passed to notify().
// A key absent from a user's notif_prefs means ON (opt-out model).

export type NotifPrefItem = { key: string; label: string };

export const CHANNELS: NotifPrefItem[] = [
  { key: "email", label: "Email" },
  { key: "sms", label: "Text message" },
];

export const TYPES_BY_ROLE: Record<"manager" | "employee", NotifPrefItem[]> = {
  employee: [
    { key: "shift_published", label: "A new shift is posted for me" },
    { key: "schedule_change", label: "When my schedule changes" },
    { key: "shift_reminder", label: "Reminder before my shift starts" },
    { key: "missed_clockin", label: "Alert if I haven't clocked in" },
    { key: "drop_decision", label: "When my drop request is approved or denied" },
    { key: "timeoff_decision", label: "When my time-off request is approved or denied" },
  ],
  manager: [
    { key: "missed_clockin", label: "When a staff member misses a clock-in" },
    { key: "shift_picked_up", label: "When an open shift is picked up" },
    { key: "drop_request", label: "Swap / drop requests" },
    { key: "time_off_request", label: "Time-off requests" },
    { key: "availability_change", label: "When someone changes their availability" },
    { key: "timeoff_cancelled", label: "When approved time off is cancelled" },
  ],
};
