export type Role = "manager" | "employee";

export type Profile = {
  id: string; // uuid, references auth.users
  full_name: string | null;
  phone: string | null;
  role: Role;
  hourly_rate: number | null;
  active: boolean;
  created_at: string;
};

export type Location = {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
  is_default: boolean;
  created_at: string;
};

export type Shift = {
  id: number;
  employee_id: string | null;
  location_id: number | null;
  starts_at: string; // ISO timestamptz
  ends_at: string; // ISO timestamptz
  position: string | null;
  notes: string | null;
  published: boolean;
  created_at: string;
  updated_at: string;
};

export type TimeEntry = {
  id: number;
  employee_id: string;
  shift_id: number | null;
  location_id: number | null;
  clock_in_at: string;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  clock_in_accuracy_m: number | null;
  clock_in_distance_m: number | null;
  clock_out_at: string | null;
  clock_out_lat: number | null;
  clock_out_lng: number | null;
  clock_out_distance_m: number | null;
  status: "open" | "closed";
  created_at: string;
};

export type Notification = {
  id: number;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  sent_email: boolean;
  sent_sms: boolean;
  read_at: string | null;
  created_at: string;
};

// Joined shapes used by some views
export type ShiftWithEmployee = Shift & { profiles: Pick<Profile, "id" | "full_name"> | null };
export type TimeEntryWithEmployee = TimeEntry & { profiles: Pick<Profile, "id" | "full_name" | "hourly_rate"> | null };

export type Availability = {
  id: number;
  employee_id: string;
  weekday: number | null; // 0=Sun..6=Sat
  specific_date: string | null;
  start_time: string | null; // "HH:MM:SS"
  end_time: string | null;
  is_available: boolean;
  note: string | null;
  status: "pending" | "approved" | "denied";
  created_at: string;
};

export type ShiftRequest = {
  id: number;
  shift_id: number;
  employee_id: string;
  type: "drop";
  status: "pending" | "approved" | "denied" | "cancelled";
  note: string | null;
  created_at: string;
};
