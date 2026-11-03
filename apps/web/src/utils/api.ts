export const getBotApiUrl = () => {
  // Le navigateur passe toujours par le proxy Next.js, qui injecte le secret et l'identité Discord.
  return '/api/bot';
};

export async function botApiFetch(input: string, init?: RequestInit): Promise<Response> {
  const path = input.startsWith('/api/') ? input.slice(4) : input;
  return fetch(`${getBotApiUrl()}${path}`, init);
}
