import { APP_BRAND_NAME } from "../brand";

interface AppHeaderProps {
  onRefresh: () => void;
}

export function AppHeader({ onRefresh }: AppHeaderProps) {
  return (
    <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-10">
      <div className="w-full max-w-none min-w-0 mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{APP_BRAND_NAME}</h1>
          <p className="text-sm text-slate-400">Co-pilot dashboard — approve before send</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="text-sm px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700"
        >
          Refresh
        </button>
      </div>
    </header>
  );
}
