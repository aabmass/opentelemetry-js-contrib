async function main() {
  const res = await fetch('https://opentelemetry.io');
  console.log('Got status %s', res.status);
}

main();
