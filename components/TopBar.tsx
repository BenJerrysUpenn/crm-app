export default function TopBar({ email }: { email: string }) {
  return (
    <header className="bg-zinc-950 border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
      <div className="flex items-baseline gap-3">
        <h1 className="font-semibold text-zinc-100">Withers CRM</h1>
        <span className="text-xs text-zinc-500">Catering pipeline</span>
      </div>
      <div className="flex items-center gap-4">
        <span className="text-sm text-zinc-400">{email}</span>
        <form action="/api/logout" method="post">
          <button
            type="submit"
            className="text-sm bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-md px-3 py-1.5 border border-zinc-700"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
