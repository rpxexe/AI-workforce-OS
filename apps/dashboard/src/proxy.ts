import { clerkMiddleware } from "@clerk/nextjs/server";

const PUBLIC_PATHS = ["/sign-in", "/sign-up"];

// Every page requires a session unless it is listed above, so a new route is protected by default.
// Signed-out visitors are sent to the app's own sign-in page. Data is protected separately by the API.
export default clerkMiddleware(
  async (auth, request) => {
    const { pathname } = request.nextUrl;
    const isPublic = PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
    if (!isPublic) await auth.protect();
  },
  { signInUrl: "/sign-in", signUpUrl: "/sign-up" },
);

export const config = {
  // Everything except Next.js internals and static files.
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)"],
};
