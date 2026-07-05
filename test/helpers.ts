/** Utilidades compartilhadas dos testes. */

/**
 * Espera uma condição virar verdade (polling), com teto — o antídoto contra sleeps
 * fixos que flakam em runner lento. Não lança no timeout: a asserção do teste é que
 * deve falhar, com a mensagem certa.
 */
export async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}
