import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, OAuthProvider } from "firebase/auth";

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyDKWwPNyteso4cilDTlEP6RGWZkzxBC10Y",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "simple-track-prod.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "simple-track-prod",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "simple-track-prod.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "756756653973",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:756756653973:web:27a5a1379494113eb7b89c",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-JQEDYZX57T"
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const googleProvider = new GoogleAuthProvider();
export const microsoftProvider = new OAuthProvider("microsoft.com");

googleProvider.addScope("profile");
googleProvider.addScope("email");
googleProvider.setCustomParameters({ prompt: "select_account" });
microsoftProvider.addScope("profile");
microsoftProvider.addScope("email");
microsoftProvider.setCustomParameters({ prompt: "select_account" });
