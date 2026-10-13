import { useState } from "react";
import {
  APP_BRAND_BYLINE,
  APP_BRAND_COMPANY,
  APP_BRAND_NAME,
  APP_LOGO_SRC,
} from "../brand";

type AppBrandProps = {
  variant?: "sidebar" | "login" | "compact";
  className?: string;
};

export function AppBrand({ variant = "sidebar", className = "" }: AppBrandProps) {
  const [logoVisible, setLogoVisible] = useState(true);

  const logoSize =
    variant === "login" ? "h-14 w-14" : variant === "compact" ? "h-8 w-8" : "h-11 w-11";

  const titleClass =
    variant === "login"
      ? "text-2xl font-bold tracking-tight text-sky-400"
      : variant === "compact"
        ? "text-sm font-semibold tracking-tight text-sky-300 truncate"
        : "text-lg font-bold tracking-tight text-sky-400 leading-tight";

  return (
    <div className={`flex items-start gap-3 min-w-0 ${className}`}>
      {logoVisible ? (
        <img
          src={APP_LOGO_SRC}
          alt="Kafi Commodities"
          className={`${logoSize} shrink-0 object-contain rounded-md`}
          onError={() => setLogoVisible(false)}
        />
      ) : null}
      <div className="min-w-0">
        <p className={titleClass}>{APP_BRAND_NAME}</p>
        {variant === "sidebar" ? (
          <>
            <p className="mt-1 text-sm font-medium text-slate-300">
              <span className="text-slate-500 font-normal">by </span>
              {APP_BRAND_BYLINE}
            </p>
            <p className="mt-1.5 text-xs text-slate-500 leading-relaxed">{APP_BRAND_COMPANY}</p>
          </>
        ) : variant === "login" ? (
          <p className="mt-1 text-sm text-slate-400">{APP_BRAND_COMPANY}</p>
        ) : null}
      </div>
    </div>
  );
}
