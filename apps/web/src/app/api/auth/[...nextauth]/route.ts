import NextAuth from "next-auth/next";
import { NextAuthOptions } from "next-auth";
import DiscordProvider from "next-auth/providers/discord";

export const authOptions: NextAuthOptions = {
  providers: [
    DiscordProvider({
      clientId: process.env.DISCORD_CLIENT_ID || "",
      clientSecret: process.env.DISCORD_CLIENT_SECRET || "",
      issuer: "https://discord.com",
      authorization: { params: { scope: "identify guilds" } },
    }),
  ],
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account) {
        token.accessToken = account.access_token;
        if (profile && 'id' in profile) {
          token.id = (profile as any).id;
        }
      }
      return token;
    },
    async session({ session, token }) {
      (session as { accessToken?: unknown }).accessToken = token.accessToken;
      if (session.user) {
        (session.user as { id?: unknown }).id = token.id || token.sub;
      }
      return session;
    },
  },
  pages: {
    signIn: '/',
  },
  // Pas de valeur de repli : sans NEXTAUTH_SECRET, NextAuth refuse de signer les sessions (fail-closed).
  secret: process.env.NEXTAUTH_SECRET,
};

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
