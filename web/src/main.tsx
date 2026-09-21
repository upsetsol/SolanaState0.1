import "./polyfill";
import React from "react";
import { createRoot } from "react-dom/client";
import { WalletProvider } from "@solana/wallet-adapter-react";
import { AppProvider } from "./lib/ctx";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <WalletProvider wallets={[]} autoConnect>
    <AppProvider>
      <App />
    </AppProvider>
  </WalletProvider>
);
