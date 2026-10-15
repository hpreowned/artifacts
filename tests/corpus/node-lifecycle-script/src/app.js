async function main() {
  const res = await fetch("/api/companies");
  const companies = await res.json();
  document.getElementById("app").textContent = JSON.stringify(companies);
}
main();
