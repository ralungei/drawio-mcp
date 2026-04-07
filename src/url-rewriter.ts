/**
 * Intercepts JSON-RPC responses from @drawio/mcp and injects &clibs=U<url>
 * into draw.io URLs so the OCI library appears in the sidebar.
 */

const DRAWIO_URL_REGEX = /(https:\/\/(?:app\.diagrams\.net|embed\.diagrams\.net)\/\?[^"'\s]*)/g;

const OCI_OBJECT_STORAGE_URL =
  "https://frpj5kvxryk1.objectstorage.us-chicago-1.oci.customer-oci.com/p/peq8PZJIVio5o1vArY0pXxiV_P3EtKVw0WUEwkfHorlRay5Dp59866n1lxSGRvFn/n/frpj5kvxryk1/b/ppt-mcp-bucket/o/oci-library.xml";

export function getLibraryBaseUrl(port: string | number): string {
  return process.env.LIBRARY_BASE_URL || OCI_OBJECT_STORAGE_URL;
}

export function rewriteDrawioUrls(responseJson: string, libraryUrl: string): string {
  return responseJson.replace(DRAWIO_URL_REGEX, (match) => {
    // Don't add clibs if already present
    if (match.includes("clibs=")) return match;
    const encodedUrl = encodeURIComponent(libraryUrl);
    const separator = match.includes("?") ? "&" : "?";
    return `${match}${separator}clibs=U${encodedUrl}`;
  });
}
