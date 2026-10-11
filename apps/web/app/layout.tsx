import type { ReactNode } from "react";
import "./globals.css";
export const metadata = {
  title: "Fairwork — milestone escrow",
  description: "A local milestone escrow dashboard with private terms, verifiable deadlines and bounded arbitration.",
};
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
