#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef CYRENE_VERSION
#define CYRENE_VERSION "unknown"
#endif

static void fail(const char *message) {
  fprintf(stderr, "cyrene-web: %s: %s\n", message, strerror(errno));
  exit(127);
}

static void join(char *output, size_t capacity, const char *root, const char *relative) {
  if (snprintf(output, capacity, "%s/%s", root, relative) >= (int)capacity) {
    errno = ENAMETOOLONG;
    fail("installation path is too long");
  }
}

int main(int argc, char **argv) {
#if !defined(__linux__) || !defined(__x86_64__)
#error This launcher is intended for Linux x86_64 only
#endif
  char root[PATH_MAX], node[PATH_MAX], entry[PATH_MAX], browsers[PATH_MAX], runtime[PATH_MAX];
  const ssize_t length = readlink("/proc/self/exe", root, sizeof(root) - 1);
  if (length < 0) fail("cannot locate this executable");
  if ((size_t)length >= sizeof(root) - 1) { errno = ENAMETOOLONG; fail("installation path is too long"); }
  root[length] = '\0';
  char *slash = strrchr(root, '/');
  if (!slash) { errno = EINVAL; fail("invalid executable path"); }
  *slash = '\0';
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    printf("Cyrene Web %s (Linux x86_64 portable)\n", CYRENE_VERSION);
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--help") == 0) {
    puts("Cyrene Web Linux portable\nUsage: ./cyrene-web [--help|--version]\nConfiguration: CYRENE_DATA_DIR, CYRENE_WEB_HOST, CYRENE_WEB_PORT, CYRENE_SETUP_TOKEN\nKeep the entire extracted directory. Node.js and both Chromium versions are bundled.\nMaintenance: ./cyrene-web --node <Node.js arguments>");
    return 0;
  }
  const int node_mode = argc > 1 && strcmp(argv[1], "--node") == 0;
  if (argc > 1 && !node_mode) { fputs("Unknown argument; use --help.\n", stderr); return 2; }
  join(node, sizeof(node), root, "runtime/node");
  join(runtime, sizeof(runtime), root, "runtime");
  join(entry, sizeof(entry), root, "dist/server/server/index.js");
  join(browsers, sizeof(browsers), root, "browsers");
  if (access(node, X_OK) != 0) fail("bundled runtime/node is missing or not executable");
  if (chdir(root) != 0) fail("cannot enter installation directory");
  if (setenv("CYRENE_APP_ROOT", root, 1) != 0 || setenv("CYRENE_HEADLESS", "1", 1) != 0) fail("cannot configure application root");
  if (!getenv("PLAYWRIGHT_BROWSERS_PATH") && setenv("PLAYWRIGHT_BROWSERS_PATH", browsers, 0) != 0) fail("cannot configure browser directory");
  const char *original_path = getenv("PATH");
  if (!original_path) original_path = "/usr/bin:/bin";
  const size_t path_length = strlen(runtime) + strlen(original_path) + 2;
  char *search_path = malloc(path_length);
  if (!search_path) fail("cannot allocate runtime PATH");
  snprintf(search_path, path_length, "%s:%s", runtime, original_path);
  if (setenv("PATH", search_path, 1) != 0) fail("cannot configure runtime PATH");
  free(search_path);
  char **arguments = calloc((size_t)argc + 3, sizeof(char *));
  if (!arguments) fail("cannot allocate arguments");
  arguments[0] = node;
  if (node_mode) {
    for (int i = 2; i < argc; i++) arguments[i - 1] = argv[i];
  } else arguments[1] = entry;
  // Replace this process: systemd and Ctrl+C signals reach Node directly, and
  // Node's own execPath remains usable by fork(), workers and stdio MCP servers.
  execv(node, arguments);
  fail("cannot execute bundled Node.js");
}
