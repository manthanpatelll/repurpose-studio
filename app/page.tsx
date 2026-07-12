import { redirect } from "next/navigation";

// Repurpose Studio lives at /repurpose-studio (keeping the route intact means
// every internal <Link> / router.push still resolves). The app root just sends
// visitors straight there so `npm run dev` + localhost lands on the studio.
export default function Home() {
  redirect("/repurpose-studio");
}
