import { redirect } from "next/navigation";

export default function Home() {
  // The console entry point is the live order board; auth guards redirect to
  // /login when there is no session.
  redirect("/orders");
}
