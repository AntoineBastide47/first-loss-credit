"use client";

import { createContext, useContext, useState, useCallback } from "react";

const WalletContext = createContext(undefined);

export function WalletProvider({ children }) {
  const [walletManager, setWalletManagerState] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [accountInfo, setAccountInfo] = useState(null);
  const [events, setEvents] = useState([]);
  const [statusMessage, setStatusMessage] = useState(null);

  const setWalletManager = useCallback((manager) => {
    setWalletManagerState(manager);
  }, []);

  const addEvent = useCallback((name, data) => {
    const timestamp = new Date().toLocaleTimeString();
    setEvents((prev) => [{ timestamp, name, data }, ...prev]);
  }, []);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  const showStatus = useCallback((message, type) => {
    setStatusMessage({ message, type });
    setTimeout(() => {
      setStatusMessage(null);
    }, 5000);
  }, []);

  return (
    <WalletContext.Provider
      value={{
        walletManager,
        isConnected,
        accountInfo,
        events,
        statusMessage,
        setWalletManager,
        setIsConnected,
        setAccountInfo,
        addEvent,
        clearEvents,
        showStatus,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const context = useContext(WalletContext);
  if (context === undefined) {
    throw new Error("useWallet must be used within a WalletProvider");
  }
  return context;
}
