package acceptance;
import java.sql.Statement;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.FileInputStream;
class Acceptance12 {
@GetMapping("/document") byte[] document(String name) throws Exception { Path target; if("terms".equals(name)) target=Path.of("/srv/static/terms.txt"); else if("privacy".equals(name)) target=Path.of("/srv/static/privacy.txt"); else throw new IllegalArgumentException(); return Files.readAllBytes(target); }
}
