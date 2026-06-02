export default function TopBar({ email }: { email: string }) {
  return (
    <header className="bg-white border-b border-stone-200 px-6 py-3 flex items-center justify-between">
      <div className="flex items-baseline gap-3">
        <h1 className="font-semibold text-stone-900">Withers CRM</h1>
        <span className="text-xs text-stone-500">Catering pipeline</span>
      </div>
      <div className="flex items-center gap-4">
        <span className="text-sm text-stone-600">{email}</span>
        <form action="/api/logout" method="post">
          <button
            type="submit"
            className="text-sm bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-md px-3 py-1.5 border border-stone-200"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
