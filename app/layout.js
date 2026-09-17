import { Bricolage_Grotesque, Instrument_Sans } from "next/font/google";
import "./globals.css";

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
});

const instrument = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument",
});

export const metadata = {
  title: "CreatorFlow AI - Reels, Images and Memes",
  description:
    "A local AI creator studio for Instagram and Facebook reels, images and memes with reach optimization workflows.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${bricolage.variable} ${instrument.variable}`}>{children}</body>
    </html>
  );
}
