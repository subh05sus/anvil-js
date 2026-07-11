export const uri = 'anvil://greeting';
export const name = 'greeting';
export const description = 'A friendly greeting';
export const mimeType = 'text/plain';

export function read() {
  return { text: 'Hello from Anvil' };
}
