export const FEATURED_MASTERS = [
  { username: "MagnusCarlsen", name: "Magnus Carlsen" },
  { username: "Hikaru", name: "Hikaru Nakamura" },
  { username: "fabianocaruana", name: "Fabiano Caruana" },
  { username: "DanielNaroditsky", name: "Daniel Naroditsky" },
  { username: "anishgiri", name: "Anish Giri" },
  { username: "GMWSO", name: "Wesley So" },
  { username: "NihalSarin", name: "Nihal Sarin" },
  { username: "LevonAronian", name: "Levon Aronian" },
  { username: "Firouzja2003", name: "Alireza Firouzja" },
  { username: "Jospem", name: "José Martínez" },
  { username: "Oleksandr_Bortnyk", name: "Oleksandr Bortnyk" },
  { username: "chessbrah", name: "Eric Hansen" },
  { username: "lachesisQ", name: "Ian Nepomniachtchi" },
  { username: "viditchess", name: "Vidit Gujrathi" },
  { username: "vartemiev", name: "Vladislav Artemiev" },
  { username: "gukeshdommaraju", name: "Gukesh Dommaraju" },
  { username: "dudaki", name: "Jan-Krzysztof Duda" },
];

export async function fetchGrandmasterHandles() {
  const response = await fetch("https://api.chess.com/pub/titled/GM", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("The grandmaster directory is unavailable right now.");
  const data = await response.json();
  return Array.isArray(data.players) ? data.players.map(String) : [];
}
