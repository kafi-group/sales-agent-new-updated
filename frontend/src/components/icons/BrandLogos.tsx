import whatsappLogo from "../../assets/brands/whatsapp.svg?url";
import outlookLogo from "../../assets/brands/outlook.svg?url";
import twilioLogo from "../../assets/brands/twilio.svg?url";
import linkedinLogo from "../../assets/brands/linkedin.svg?url";
import telegramLogo from "../../assets/brands/telegram.svg?url";

type BrandSize = "xs" | "sm" | "md" | "lg";

const SIZE_CLASS: Record<BrandSize, string> = {
  xs: "h-3.5 w-3.5",
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6",
};

type BrandLogoProps = {
  size?: BrandSize;
  className?: string;
  title?: string;
};

function BrandImg({
  src,
  alt,
  size = "sm",
  className = "",
  title,
}: BrandLogoProps & { src: string; alt: string }) {
  return (
    <img
      src={src}
      alt={alt}
      title={title || alt}
      draggable={false}
      className={`${SIZE_CLASS[size]} shrink-0 object-contain ${className}`}
      aria-hidden={title ? undefined : true}
    />
  );
}

/** Official WhatsApp brand mark (Meta). */
export function LogoWhatsApp({ size, className, title }: BrandLogoProps) {
  return (
    <BrandImg
      src={whatsappLogo}
      alt="WhatsApp"
      size={size}
      className={className}
      title={title}
    />
  );
}

/** Official Microsoft Outlook app icon. */
export function LogoOutlook({ size, className, title }: BrandLogoProps) {
  return (
    <BrandImg
      src={outlookLogo}
      alt="Outlook"
      size={size}
      className={className}
      title={title}
    />
  );
}

/** Official Twilio brand mark. */
export function LogoTwilio({ size, className, title }: BrandLogoProps) {
  return (
    <BrandImg
      src={twilioLogo}
      alt="Twilio"
      size={size}
      className={className}
      title={title}
    />
  );
}

/** LinkedIn brand mark (for mail label folders). */
export function LogoLinkedIn({ size, className, title }: BrandLogoProps) {
  return (
    <BrandImg
      src={linkedinLogo}
      alt="LinkedIn"
      size={size}
      className={className}
      title={title}
    />
  );
}

/** Telegram brand mark. */
export function LogoTelegram({ size, className, title }: BrandLogoProps) {
  return (
    <BrandImg
      src={telegramLogo}
      alt="Telegram"
      size={size}
      className={className}
      title={title}
    />
  );
}
