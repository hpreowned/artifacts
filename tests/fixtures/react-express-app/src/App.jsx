import React, { useEffect, useState } from "react";

// The client fetches its data from the Express API at view time. That one call is what the publish
// skill has to notice: on the static tier it dies (connect-src 'none'); on the node tier it works.
export default function App() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    fetch("/api/items").then((r) => r.json()).then(setItems).catch((e) => setError(String(e)));
  }, []);
  return (
    <main style={{ fontFamily: "system-ui", margin: "2rem" }}>
      <h1>Team inventory</h1>
      {error && <p style={{ color: "#b00" }}>Could not load items: {error}</p>}
      {!items && !error && <p>Loading…</p>}
      {items && (
        <table>
          <tbody>
            {items.map((it) => (
              <tr key={it.sku}><td>{it.sku}</td><td>{it.name}</td><td>{it.qty}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
