export const uriTemplate = 'anvil://users/{id}';
export const name = 'user';
export const description = 'A user by id';
export const mimeType = 'application/json';

export function read(vars) {
  return { text: JSON.stringify({ id: vars.id }) };
}
