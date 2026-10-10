# Reimbursement files live in Supabase Storage, not Google Drive

Receipts, Lyft ride reports and Adjustment evidence uploaded in Withers Time are stored in a private Supabase Storage bucket, read through the app's own access rules (staff see their own, Approvers see all). Google Drive was the natural archive, but the time app runs on Vercel with no Drive API credential and no access to the Drive folder synced on Alina's Mac, so Drive would add a new Google credential, upload-size workarounds and a fetch-back path for Approvers. Receipts still reach Drive by the existing route: emailed to receipts@, read by the receipt processor, archived under `Receipts/YYYY/MM/`. Only Adjustment evidence stays app-only, and it is only ever looked at in the approval queue.

## Considered Options

- **Google Drive via the Drive API.** Rejected: new credential, Vercel request-size limits for phone photos, and the app breaks when Drive is slow or the token lapses.
- **Supabase plus a nightly copy to Drive.** Not needed now; add it later if Alina wants evidence browsable in Drive.
