export default function handler() {
  return {
    name: 'anvil basic-api example',
    try: ['/users', '/users/1', '/files/a/b.txt', '/dashboard (needs x-admin-token: letmein)', '/hello.txt', '/playground.html'],
  };
}
