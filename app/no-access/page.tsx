export const dynamic = "force-dynamic";

export default function NoAccessPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-8 w-full max-w-md text-center space-y-4">
        <h1 className="text-xl font-semibold text-slate-100">No access</h1>
        <p className="text-sm text-slate-400">
          This account isn&apos;t authorized for the CRM. If you&apos;re here to
          clock in or see your schedule, go to{" "}
          <a
            href="https://time.withers-ventures.com"
            className="text-sky-400 hover:underline"
          >
            time.withers-ventures.com
          </a>
          .
        </p>
        <p className="text-xs text-slate-500">
          If you think you should have CRM access, ask an admin to set your role
          to manager.
        </p>
        <form action="/api/logout" method="post">
          <button className="text-xs text-slate-400 hover:text-slate-200 border border-slate-700 rounded-md px-3 py-1.5">
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
