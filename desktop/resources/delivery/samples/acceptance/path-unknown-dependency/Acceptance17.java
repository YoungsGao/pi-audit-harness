package acceptance;
import java.sql.Statement;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.FileInputStream;
class Acceptance17 {
FilePolicy policy; @GetMapping("/policy-file") byte[] file(String name) throws Exception { return Files.readAllBytes(policy.authorizeAndResolve(name)); }
}
