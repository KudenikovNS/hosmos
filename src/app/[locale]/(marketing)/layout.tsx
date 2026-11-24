// The public pages keep the serif display voice (landing ТЗ 15.08.2026);
// `globals.css` scopes `--font-serif` headings to this wrapper, so the product
// UI behind the login is one family (DM Sans) throughout.
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="marketing">{children}</div>;
}
