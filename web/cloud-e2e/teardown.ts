export default async function teardown(): Promise<void> {
  const response = await fetch('http://127.0.0.1:4312/__test/shutdown', {
    method: 'POST', signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error('Isolated cloud fixture cleanup failed');
  await response.text();
}
