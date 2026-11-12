import "./globals.css";

export const metadata = {
  title: "TestLab: know what to test, and get the tests",
  description: "Scan a JavaScript project, get a recommended test mix, edge cases, and generated, verified test files.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
