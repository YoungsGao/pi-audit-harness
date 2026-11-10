package acceptance;
import java.sql.Statement;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.FileInputStream;
class Acceptance09 {
@GetMapping("/download") byte[] download(String name) throws Exception { Path target=Path.of("/srv/public").resolve(name); return Files.readAllBytes(target); }
}
