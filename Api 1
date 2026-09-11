<script>
async function pay() {
  const res = await fetch('/api/pay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '254712345678', amount: 100 })
  });
  const data = await res.json();
  console.log(data);
}
</script>
